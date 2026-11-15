import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOSE, isHello, pairKeys, parseFragment, unb64url, type Channel, type PhoneMsg } from '../src/pair-crypto.ts';
import { Pairing, createRoom, loadRoom, qrSvg, qrUrl, saveRoom, type Reply, type Socket } from '../src/pair.ts';

const room = createRoom('https://blob-relay.example.workers.dev/');

/** One connection: both sides say hello and make this connection's keys. */
async function connection(r = room): Promise<{ pc: Channel; phone: Channel }> {
  const pc = await pairKeys(r.secret, r.room, 'pc'), phone = await pairKeys(r.secret, r.room, 'phone');
  const a = await pc.hello(), b = await phone.hello();
  return { pc: await pc.channel(b), phone: await phone.channel(a) };
}

describe('pairing crypto', () => {
  it('round-trips both ways, with a different key per direction', async () => {
    const { pc, phone } = await connection();
    const req = await phone.seal({ t: 'req', id: '1', text: 'open notepad ✓' });
    expect(await pc.open(req)).toEqual({ t: 'req', id: '1', text: 'open notepad ✓' });
    expect(await phone.open(await pc.seal({ t: 'answer', text: 'Done.' }))).toEqual({ t: 'answer', text: 'Done.' });
    expect(new TextDecoder().decode(req)).not.toContain('notepad');
    await expect(phone.open(req)).rejects.toThrow();       // a frame does not open on the side that sent it
    const a = await pairKeys(room.secret, room.room, 'pc'), b = await pairKeys(room.secret, room.room, 'phone');
    expect(a.auth).toBe(b.auth);                            // the relay token is the pairing's, not the connection's
    expect(a.auth).toMatch(/^[\w-]{22}$/);
    expect(isHello(await a.hello())).toBe(true);
    expect(isHello(req)).toBe(false);
  });

  it('keeps the order of frames sealed at once', async () => {
    const { pc, phone } = await connection();
    const frames = await Promise.all([1, 2, 3].map(i => phone.seal({ i })));
    expect(await Promise.all(frames.map(f => pc.open(f)))).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  });

  it('fails with a wrong key, a wrong room, a changed frame and a replay', async () => {
    const { pc, phone } = await connection();
    const frame = await phone.seal({ t: 'req', id: '1', text: 'hi' });
    const other = createRoom('https://x');
    await expect((await connection({ ...room, secret: other.secret })).pc.open(frame)).rejects.toThrow();
    await expect((await connection({ ...room, room: other.room })).pc.open(frame)).rejects.toThrow();
    const changed = frame.slice(0);
    new Uint8Array(changed)[20] ^= 1;
    await expect(pc.open(changed)).rejects.toThrow();
    await pc.open(frame);
    await expect(pc.open(frame)).rejects.toThrow('replayed');
  });

  it('makes new keys for every connection: a frame recorded in an old one fails in a new one', async () => {
    const old = await connection();
    const recorded = await old.phone.seal({ t: 'req', id: '1', text: 'delete my files' });
    expect(await old.pc.open(recorded)).toMatchObject({ t: 'req' });   // it was a good frame in its own connection
    const next = await connection();                                    // same pairing, same secret, a later connection
    await expect(next.pc.open(recorded)).rejects.toThrow();
    // Also when only one side is new (the PC restarted, an attacker replays the phone's old hello and frame).
    const pc = await pairKeys(room.secret, room.room, 'pc'), phone = await pairKeys(room.secret, room.room, 'phone');
    const phoneHello = await phone.hello();
    const first = await phone.channel(await pc.hello());
    const frame = await first.seal({ t: 'req', id: '2', text: 'again' });
    await pc.hello();                                                   // the PC's next connection: a new nonce
    await expect((await pc.channel(phoneHello)).open(frame)).rejects.toThrow();
  });

  it('takes a hello only from the other side, and uses its own nonce for one channel only', async () => {
    const pc = await pairKeys(room.secret, room.room, 'pc'), phone = await pairKeys(room.secret, room.room, 'phone');
    await expect(pc.channel(await phone.hello())).rejects.toThrow('no hello of our own');   // nothing to pair it with yet
    const mine = await pc.hello();
    await expect(pc.channel(mine)).rejects.toThrow('not from the other side');              // its own hello sent back
    await pc.hello();
    const forged = (await phone.hello()).slice(0);
    new Uint8Array(forged)[3] ^= 1;                                                          // a nonce the relay made up
    await expect(pc.channel(forged)).rejects.toThrow('not from the other side');
    await pc.hello();
    const stranger = await pairKeys(createRoom('https://x').secret, room.room, 'phone');     // signed with another secret
    await expect(pc.channel(await stranger.hello())).rejects.toThrow('not from the other side');

    // A good hello makes one channel. Sent again, it makes no second one with the same keys and a counter back at 0.
    await pc.hello();
    const hello = await phone.hello();
    const ch = await pc.channel(hello);
    expect(ch).toBeDefined();
    await expect(pc.channel(hello)).rejects.toThrow('no hello of our own');
  });
});

describe('pairing room', () => {
  it('makes a random 16-byte id and a 32-byte secret', () => {
    expect(unb64url(room.room)).toHaveLength(16);
    expect(unb64url(room.secret)).toHaveLength(32);
    const again = createRoom('https://blob-relay.example.workers.dev');
    expect(again.room).not.toBe(room.room);
    expect(again.secret).not.toBe(room.secret);
  });

  it('puts the room and the secret in the fragment only', () => {
    const url = qrUrl(room);
    expect(url).toBe(`https://blob-relay.example.workers.dev/phone/#r=${room.room}&k=${room.secret}`);
    const u = new URL(url);
    expect(u.pathname + u.search).toBe('/phone/');
    expect(parseFragment(u.hash)).toEqual({ room: room.room, secret: room.secret });
    expect(parseFragment('#r=short&k=short')).toBeNull();
    expect(parseFragment('')).toBeNull();
  });

  it('draws the QR as shapes only: no text, title, link or the secret in the SVG', () => {
    const svg = qrSvg(qrUrl(room));
    expect(svg).toMatch(/^<svg[^>]+viewBox=/);
    expect(svg).toContain('#1c1c1e');
    expect(svg.length).toBeLessThan(40_000);
    expect(svg).not.toMatch(/<(text|title|desc|a)\b|href|aria-label/i);
    expect(svg).not.toContain(room.secret);
    expect(svg).not.toContain(room.room);
  });
});

/** The relay and the phone, in memory: what the PC's socket sends lands in `sent`; `phone` talks back. */
class FakeRelay implements Socket {
  binaryType = '';
  readyState = 1;
  onopen: Socket['onopen'] = null; onmessage: Socket['onmessage'] = null; onclose: Socket['onclose'] = null;
  sent: (string | ArrayBuffer)[] = [];
  send(d: string | ArrayBuffer) { this.sent.push(d); }
  close() { this.readyState = 3; }
  say(data: string | ArrayBuffer) { this.onmessage?.({ data }); }
}
/** Waits until the Pairing has handled every frame it was given (its queue is empty), not for a fixed time. */
async function settled(p: Pairing): Promise<void> {
  const q = p as unknown as { line: Promise<unknown> };
  for (let line; line !== q.line;) await (line = q.line);
}

describe('the PC side of a pairing', () => {
  let dir = '', file = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blob-pair-')); file = join(dir, 'pair.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A connected Pairing with the phone's hello done; `phone` seals what the phone would send. */
  async function paired() {
    saveRoom(file, room);
    const relay = new FakeRelay();
    let url = '';
    const p = new Pairing(room, { file, open: u => { url = u; return relay; } });
    const got = { replies: [] as Reply[], requests: [] as string[], phone: [] as boolean[], over: [] as string[] };
    p.on('reply', r => got.replies.push(r)).on('request', r => got.requests.push(r.text))
      .on('phone', on => got.phone.push(on)).on('unpaired', why => got.over.push(why));
    await p.connect();
    relay.say('{"t":"peer","on":true}');
    await settled(p);
    const pcHello = relay.sent.find(d => typeof d !== 'string' && isHello(d)) as ArrayBuffer;
    const keys = await pairKeys(room.secret, room.room, 'phone');
    const phoneHello = await keys.hello();
    relay.say(phoneHello);
    const phone = await keys.channel(pcHello);
    await settled(p);
    const from = async (m: PhoneMsg) => { const f = await phone.seal(m); relay.say(f); await settled(p); return f; };
    return { p, relay, got, from, phoneHello, url };
  }

  it('saves and loads the pairing, and takes nothing that is not one', () => {
    expect(loadRoom(file)).toBeNull();
    saveRoom(file, room);
    expect(loadRoom(file)).toEqual(room);
    saveRoom(file, { ...room, secret: 'short' });
    expect(loadRoom(file)).toBeNull();
    saveRoom(file, { ...room, pc: '' });
    expect(loadRoom(file)).toBeNull();
  });

  it('shows the relay its own PC token, which the QR link does not carry', async () => {
    const { p, url } = await paired();
    expect(url).toContain(`&pc=${room.pc}`);
    expect(qrUrl(room)).not.toContain(room.pc);
    expect(unb64url(room.pc)).toHaveLength(16);
    p.close();
  });

  it('ignores a hello sent again in the same connection: recorded frames do not open a second time', async () => {
    const { p, relay, got, from, phoneHello } = await paired();
    const frame = await from({ t: 'req', id: 'a', text: 'open notepad' });
    relay.say(phoneHello);                                     // the relay replays the phone's hello...
    await settled(p);
    relay.say(frame);                                          // ...and then the request
    await settled(p);
    expect(got.requests).toEqual(['open notepad']);            // once
    expect(got.phone).toEqual([true]);                         // and the connection is the same one
  });

  it('takes a request, and a reply only for an ask that is open', async () => {
    const { p, got, from } = await paired();
    expect(got.phone).toEqual([true]);
    await from({ t: 'req', id: 'a', text: 'open notepad' });
    expect(got.requests).toEqual(['open notepad']);

    await from({ t: 'reply', id: '1', yes: true });            // nothing was asked: dropped
    expect(got.replies).toEqual([]);
    p.ask({ id: '1', question: 'Move it to the Recycle Bin?' });
    await from({ t: 'reply', id: '2', yes: true });            // another id: dropped
    expect(got.replies).toEqual([]);
    await from({ t: 'reply', id: '1', yes: true });
    expect(got.replies).toEqual([{ id: '1', yes: true, choice: undefined, text: undefined }]);
    await from({ t: 'reply', id: '1', yes: true });            // answered already: dropped
    expect(got.replies).toHaveLength(1);

    p.ask({ id: '3', question: 'Sure?' });
    p.askDone('3');                                            // answered on the PC
    await from({ t: 'reply', id: '3', yes: true });
    expect(got.replies).toHaveLength(1);
  });

  it('forgets the saved pairing when the relay says the room is unpaired or gone', async () => {
    const a = await paired();
    expect(existsSync(file)).toBe(true);
    a.relay.say('{"t":"unpaired"}');
    await settled(a.p);
    expect(a.got.over).toEqual(['unpaired']);
    expect(existsSync(file)).toBe(false);
    expect(a.got.phone).toEqual([true, false]);

    const b = await paired();                                  // the room expired or was closed while the PC was away
    b.relay.onclose?.({ code: CLOSE.gone });
    expect(b.got.over).toEqual(['expired']);
    expect(existsSync(file)).toBe(false);

    const c = await paired();                                  // a dropped connection is not the end: the pairing stays
    c.relay.onclose?.({ code: 1006 });
    expect(c.got.over).toEqual([]);
    expect(existsSync(file)).toBe(true);
    c.p.close();
  });
});
