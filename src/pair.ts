// Phone pairing, the PC side: makes a room and its QR link, connects out to the relay, and passes end-to-end
// encrypted messages to and from the phone page. The pairing is saved in ~/.blob/pair.json so it survives a restart.
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderSVG } from 'uqr';
import { CLOSE, isHello, pairKeys, parseFragment, randomB64url, type Channel, type PairKeys, type PcMsg, type PhoneMsg, type RelayMsg } from './pair-crypto.ts';
import { blobHome } from './settings.ts';

/** A pairing. Saving these values keeps the phone paired across restarts. */
export interface RoomInfo {
  site: string;     // where the phone page and the relay live, e.g. https://blob-relay.example.workers.dev
  room: string;     // random id, 16 bytes as base64url
  secret: string;   // one-time secret, 32 bytes as base64url; it never leaves the PC and the QR
  pc: string;       // this PC's own token for the relay, 16 bytes as base64url; never in the QR, so only this PC is the room's PC
}

export function createRoom(site: string): RoomInfo {
  return { site: site.replace(/\/+$/, ''), room: randomB64url(16), secret: randomB64url(32), pc: randomB64url(16) };
}

/** The link in the QR. The room and the secret are in the fragment, which browsers never send to a server. The PC's token is not in it. */
export function qrUrl(r: RoomInfo): string {
  return `${r.site}/#r=${r.room}&k=${r.secret}`;
}

/** The QR as an SVG string, in Blob's colours. Shapes only: no text, title or link in it. */
export function qrSvg(url: string): string {
  return renderSVG(url, { ecc: 'M', border: 2, blackColor: '#1c1c1e', whiteColor: '#e9e9e9' });
}

export const pairFile = (env: NodeJS.ProcessEnv = process.env) => join(blobHome(env), 'pair.json');

/** The saved pairing, or null when there is none (or the file is not one). */
export function loadRoom(file: string): RoomInfo | null {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const ok = typeof d?.site === 'string' && /^https?:\/\//.test(d.site) && parseFragment(`#r=${d.room}&k=${d.secret}`)
      && typeof d.pc === 'string' && /^[\w-]{22}$/.test(d.pc);
    return ok ? { site: d.site, room: d.room, secret: d.secret, pc: d.pc } : null;
  } catch { return null; }
}

export function saveRoom(file: string, r: RoomInfo): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(r), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

export type Ask = { id: string; question: string; choices?: string[]; input?: boolean };
export type Reply = { id: string; yes?: boolean; choice?: string; text?: string };
type Events = {
  phone: [on: boolean];                                          // the phone is there with this connection's keys, or left
  request: [req: { id: string; text: string }];                  // the phone asked for something
  reply: [reply: Reply];                                         // its answer to an ask that is open
  stop: [];                                                      // the phone pressed Stop
  unpaired: [why: 'unpaired' | 'expired' | 'refused'];           // over: unpaired, QR never used, or another PC took the room
};
/** What Pairing needs of a WebSocket (the global one; a fake in tests). */
export interface Socket {
  binaryType: string; readyState: number;
  onopen: ((e: any) => void) | null; onmessage: ((e: { data: any }) => void) | null; onclose: ((e: { code: number }) => void) | null;
  send(data: string | ArrayBuffer): void; close(): void;
}

const RETRY_MS = [1000, 2000, 5000, 15000, 30000];
const OPEN = 1;

export class Pairing extends EventEmitter<Events> {
  private ws: Socket | null = null;
  private keys: PairKeys | null = null;
  private ch: Channel | null = null;
  private asks = new Map<string, Ask>();                 // the asks that are open: only these take a reply
  private line: Promise<unknown> = Promise.resolve();    // frames are handled one at a time, in order
  private tries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private over = false;

  /** `file`: where the pairing is saved, deleted when the pairing ends. `open`: makes the socket (tests). */
  constructor(readonly info: RoomInfo, private o: { file?: string; open?: (url: string) => Socket } = {}) { super(); }

  /** Connects, and reconnects by itself until `unpair()`, `close()` or the room is gone. */
  async connect(): Promise<void> {
    const keys = this.keys ??= await pairKeys(this.info.secret, this.info.room, 'pc');
    if (this.over) return;
    const url = `${this.info.site.replace(/^http/, 'ws')}/room/${this.info.room}?role=pc&auth=${keys.auth}&pc=${this.info.pc}`;
    const ws = this.ws = this.o.open ? this.o.open(url) : new WebSocket(url) as unknown as Socket;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.tries = 0; };
    ws.onmessage = e => {
      this.line = this.line.then(() => (this.ws === ws ? this.got(ws, e.data) : undefined))
        .catch(() => { /* not from our phone, another connection's frame, or a replay: dropped */ });
    };
    ws.onclose = e => {
      if (this.ws !== ws || this.over) return;
      this.ws = null;
      if (e.code === CLOSE.unpaired) return this.end('unpaired');
      if (e.code === CLOSE.gone) return this.end('expired');
      if (e.code === CLOSE.badAuth || e.code === CLOSE.taken) return this.end('refused');
      this.gone();
      this.timer = setTimeout(() => void this.connect(), RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
    };
  }

  private async got(ws: Socket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      const m = JSON.parse(data) as RelayMsg;
      if (m.t !== 'peer') return this.end(m.t === 'replaced' ? 'refused' : m.t);
      this.gone();
      if (m.on) ws.send(await this.keys!.hello());   // a new connection: new keys, once the phone's hello is here
      return;
    }
    if (isHello(data)) {
      if (this.ch) return;                           // one hello per connection: a second one (a replay) changes nothing
      this.ch = await this.keys!.channel(data);
      this.emit('phone', true);
      for (const a of this.asks.values()) this.send({ t: 'ask', ...a });   // the phone (re)joined: what is still open
      return;
    }
    if (!this.ch) return;
    const m: PhoneMsg = await this.ch.open(data);
    if (m.t === 'req') this.emit('request', { id: String(m.id), text: String(m.text) });
    else if (m.t === 'stop') this.emit('stop');
    else if (m.t === 'reply' && this.asks.delete(String(m.id))) {   // a reply to anything else is dropped
      this.emit('reply', { id: String(m.id), yes: m.yes, choice: m.choice, text: m.text });
    }
  }

  /** The phone left, or a new connection begins: the old keys are dropped. */
  private gone(): void {
    if (!this.ch) return;
    this.ch = null;
    this.emit('phone', false);
  }

  /** True while the phone is there and can be talked to. */
  get phoneOn(): boolean { return !!this.ch; }

  private end(why: Events['unpaired'][0]): void {
    if (this.over) return;
    this.close();
    if (this.o.file) rmSync(this.o.file, { force: true });   // the room is gone: so is the saved pairing
    this.emit('unpaired', why);
  }

  private send(msg: PcMsg): void {
    const { ws, ch } = this;
    if (!ws || !ch) return;
    void ch.seal(msg).then(frame => { if (ws.readyState === OPEN) ws.send(frame); });
  }

  /** 'working' while a task runs (with an optional line of text), 'ready' when Blob can take a request. */
  status(state: 'ready' | 'working', text?: string): void { this.send({ t: 'status', state, text }); }
  /** The answer: shown on the phone and read aloud there. */
  answer(text: string, id?: string): void { this.send({ t: 'answer', text, id }); }
  /** A Yes/No question, or a pause question with choices and/or a typed reply; the answer comes back as 'reply'. */
  ask(ask: Ask): void { this.asks.set(ask.id, ask); this.send({ t: 'ask', ...ask }); }
  /** The ask was answered on the PC (or is over): the phone drops it, and a reply to it no longer counts. */
  askDone(id: string): void { if (this.asks.delete(id)) this.send({ t: 'ask-done', id }); }

  /** Ends the pairing: the relay tells the phone, closes both sides and never opens the room again. */
  unpair(): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify({ t: 'unpair' }));
    else this.end('unpaired');
  }

  /** Disconnects without unpairing (the app is quitting). */
  close(): void {
    this.over = true;
    clearTimeout(this.timer);
    this.gone();
    this.ws?.close();
    this.ws = null;
  }
}
