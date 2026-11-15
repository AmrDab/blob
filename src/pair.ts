// Phone pairing, the PC side: makes a room and its QR link, connects out to the relay, and passes end-to-end
// encrypted messages to and from the phone page. Not wired into the app yet.
import { EventEmitter } from 'node:events';
import { renderSVG } from 'uqr';
import { CLOSE, channel, randomB64url, type Channel, type PcMsg, type PhoneMsg, type RelayMsg } from './pair-crypto.ts';

/** A pairing. Saving these three values keeps the phone paired across restarts. */
export interface RoomInfo {
  site: string;     // where the phone page and the relay live, e.g. https://blob-relay.example.workers.dev
  room: string;     // random id, 16 bytes as base64url
  secret: string;   // one-time secret, 32 bytes as base64url; it never leaves the PC and the QR
}

export function createRoom(site: string): RoomInfo {
  return { site: site.replace(/\/+$/, ''), room: randomB64url(16), secret: randomB64url(32) };
}

/** The link in the QR. The room and the secret are in the fragment, which browsers never send to a server. */
export function qrUrl(r: RoomInfo): string {
  return `${r.site}/#r=${r.room}&k=${r.secret}`;
}

/** The QR as an SVG string, in Blob's colours. */
export function qrSvg(url: string): string {
  return renderSVG(url, { ecc: 'M', border: 2, blackColor: '#1c1c1e', whiteColor: '#e9e9e9' });
}

export type Ask = { id: string; question: string; choices?: string[]; input?: boolean };
type Events = {
  phone: [on: boolean];                                          // the phone joined or left
  request: [req: { id: string; text: string }];                  // the phone asked for something
  reply: [reply: { id: string; yes?: boolean; choice?: string; text?: string }];   // its answer to an ask
  stop: [];                                                      // the phone pressed Stop
  unpaired: [why: 'unpaired' | 'expired' | 'refused'];           // over: unpaired, QR never used, or another PC took the room
};

const RETRY_MS = [1000, 2000, 5000, 15000, 30000];

export class Pairing extends EventEmitter<Events> {
  private ws: WebSocket | null = null;
  private ch: Channel | null = null;
  private tries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private over = false;

  constructor(readonly info: RoomInfo, private relay = info.site.replace(/^http/, 'ws')) { super(); }

  /** Connects, and reconnects by itself until `unpair()`, `close()` or the room is gone. */
  async connect(): Promise<void> {
    this.ch ??= await channel(this.info.secret, this.info.room, 'pc');
    if (this.over) return;
    const ch = this.ch;
    const ws = this.ws = new WebSocket(`${this.relay}/room/${this.info.room}?role=pc&auth=${ch.auth}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.tries = 0; };
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as RelayMsg;
        if (m.t === 'peer') this.emit('phone', m.on);
        else this.end(m.t === 'replaced' ? 'refused' : m.t);
        return;
      }
      ch.open(e.data as ArrayBuffer).then((m: PhoneMsg) => {
        if (m.t === 'req') this.emit('request', { id: String(m.id), text: String(m.text) });
        else if (m.t === 'reply') this.emit('reply', { id: String(m.id), yes: m.yes, choice: m.choice, text: m.text });
        else if (m.t === 'stop') this.emit('stop');
      }, () => { /* not from our phone, or a replay: dropped */ });
    };
    ws.onclose = e => {
      if (this.ws !== ws || this.over) return;
      this.ws = null;
      if (e.code === CLOSE.unpaired) return this.end('unpaired');
      if (e.code === CLOSE.gone) return this.end('expired');
      if (e.code === CLOSE.badAuth || e.code === CLOSE.taken) return this.end('refused');
      this.emit('phone', false);
      this.timer = setTimeout(() => void this.connect(), RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
    };
  }

  private end(why: Events['unpaired'][0]): void {
    if (this.over) return;
    this.close();
    this.emit('unpaired', why);
  }

  private send(msg: PcMsg): void {
    const { ws, ch } = this;
    if (!ws || !ch) return;
    void ch.seal(msg).then(frame => { if (ws.readyState === WebSocket.OPEN) ws.send(frame); });
  }

  /** 'working' while a task runs (with an optional line of text), 'ready' when Blob can take a request. */
  status(state: 'ready' | 'working', text?: string): void { this.send({ t: 'status', state, text }); }
  /** The answer: shown on the phone and read aloud there. */
  answer(text: string, id?: string): void { this.send({ t: 'answer', text, id }); }
  /** A Yes/No question, or a pause question with choices and/or a typed reply; the answer comes back as 'reply'. */
  ask(ask: Ask): void { this.send({ t: 'ask', ...ask }); }
  /** The ask was answered on the PC: the phone drops it. */
  askDone(id: string): void { this.send({ t: 'ask-done', id }); }

  /** Ends the pairing: the relay tells the phone, closes both sides and forgets the room. */
  unpair(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'unpair' }));
    else this.close();
  }

  /** Disconnects without unpairing (the app is quitting). */
  close(): void {
    this.over = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
