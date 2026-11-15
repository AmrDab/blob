import { describe, expect, it } from 'vitest';
import {
  CLOSE, IDLE_MS, MAX_BYTES, RATE, UNUSED_MS, admit, entered, frame, left, tick, type Host, type Live, type Meta, type Role, type Sock,
} from '../relay/src/room.ts';

class FakeSock implements Sock {
  got: (string | ArrayBuffer)[] = [];
  closed: number | undefined;
  constructor(readonly role: Role) {}
  send(data: string | ArrayBuffer) { this.got.push(data); }
  close(code?: number) { this.closed = code; }
  get texts() { return this.got.filter(d => typeof d === 'string'); }
}

/** The Durable Object's storage, alarm and sockets, in memory. */
function fakeRoom() {
  const state = { meta: undefined as Meta | undefined, alarm: undefined as number | undefined, all: [] as FakeSock[] };
  const host: Host = {
    meta: async () => state.meta && { ...state.meta },
    save: async m => { state.meta = { ...m }; },
    wipe: async () => { state.meta = undefined; state.alarm = undefined; },
    alarm: async at => { state.alarm = at; },
    socks: role => state.all.filter(s => s.closed === undefined && (!role || s.role === role)),
  };
  /** Joins like the Durable Object does; gives the socket, or the close code. */
  async function join(role: Role, auth = 'token', now = 0, dev = 'phone-1'): Promise<FakeSock | number> {
    const code = await admit(host, role, auth, now, role === 'phone' ? dev : undefined);
    if (code) return code;
    const s = new FakeSock(role);
    state.all.push(s);
    entered(host, role, s);
    return s;
  }
  return { state, host, join };
}

const bytes = (n: number) => new Uint8Array(n).buffer;

describe('relay room', () => {
  it('lets the PC create the room and the phone join it, and forwards binary frames untouched', async () => {
    const r = fakeRoom();
    expect(await r.join('phone')).toBe(CLOSE.gone);            // no room yet: a phone cannot make one
    const pc = await r.join('pc') as FakeSock;
    expect(pc.texts).toEqual(['{"t":"peer","on":false}']);
    expect(r.state.alarm).toBe(UNUSED_MS);
    expect(await r.join('phone', 'wrong')).toBe(CLOSE.badAuth);
    const phone = await r.join('phone') as FakeSock;
    expect(phone.texts).toEqual(['{"t":"peer","on":true}']);
    expect(pc.texts.at(-1)).toBe('{"t":"peer","on":true}');
    expect((r.state.meta as Live).paired).toBe(true);

    const a = bytes(100), b = bytes(7);
    await frame(r.host, 'phone', phone, a, 1);
    await frame(r.host, 'pc', pc, b, 1);
    expect(pc.got.at(-1)).toBe(a);
    expect(phone.got.at(-1)).toBe(b);
    await frame(r.host, 'phone', phone, 'plain text is not forwarded', 1);
    expect(pc.got.at(-1)).toBe(a);
    expect(Object.keys(r.state.meta!).sort()).toEqual(['auth', 'created', 'paired', 'phone', 'seen']);   // no content is kept
  });

  it('holds one PC and one phone: a newcomer takes the place of the old socket in its role', async () => {
    const r = fakeRoom();
    const pc = await r.join('pc') as FakeSock;
    const phone = await r.join('phone') as FakeSock;
    const phone2 = await r.join('phone') as FakeSock;          // a reload, or the old connection died silently
    expect(phone.closed).toBe(CLOSE.taken);
    expect(phone.texts.at(-1)).toBe('{"t":"replaced"}');
    expect(r.host.socks('phone')).toEqual([phone2]);
    await left(r.host, 'phone', phone, 5);                     // the old socket's close arrives late
    expect(pc.texts.at(-1)).toBe('{"t":"peer","on":true}');    // the PC is not told the phone left
    const pc2 = await r.join('pc') as FakeSock;
    expect(pc.closed).toBe(CLOSE.taken);
    expect(r.host.socks()).toHaveLength(2);
    await frame(r.host, 'phone', phone2, bytes(3), 6);
    expect(pc2.got).toHaveLength(2);                           // peer on, then the frame
    expect(await r.join('pc', 'wrong')).toBe(CLOSE.badAuth);   // and nobody gets in without the room's token
    expect(pc2.closed).toBeUndefined();
    // When the phone really leaves, the PC is told.
    phone2.close(1001);
    await left(r.host, 'phone', phone2, 7);
    expect(pc2.texts.at(-1)).toBe('{"t":"peer","on":false}');
  });

  it('expires a room no phone joined within 10 minutes', async () => {
    const r = fakeRoom();
    const pc = await r.join('pc') as FakeSock;
    await tick(r.host, UNUSED_MS - 1);
    expect(r.state.meta).toBeDefined();
    await tick(r.host, UNUSED_MS);
    expect(pc.closed).toBe(CLOSE.gone);
    expect(pc.texts.at(-1)).toBe('{"t":"expired"}');
    expect(r.state.meta).toEqual({ gone: expect.stringMatching(/^[0-9a-f]{64}$/) });   // only the mark that it was
    expect(await r.join('phone', 'token', UNUSED_MS + 1)).toBe(CLOSE.gone);

    // Also when the alarm is late: the phone is turned away and the room is gone.
    const late = fakeRoom();
    await late.join('pc');
    expect(await late.join('phone', 'token', UNUSED_MS)).toBe(CLOSE.gone);
    expect(late.state.meta).toHaveProperty('gone');
  });

  it('keeps a paired room past 10 minutes, and drops it after a long time unused', async () => {
    const r = fakeRoom();
    const pc = await r.join('pc') as FakeSock;
    const phone = await r.join('phone', 'token', 60_000) as FakeSock;
    await tick(r.host, UNUSED_MS);
    expect(pc.closed).toBeUndefined();
    expect((r.state.meta as Live).paired).toBe(true);
    pc.close(1001); await left(r.host, 'pc', pc, 1000);
    phone.close(1001); await left(r.host, 'phone', phone, 2000);
    await tick(r.host, 2000 + IDLE_MS - 1);
    expect(r.state.meta).toHaveProperty('auth');
    expect(await r.join('pc', 'token', 3000)).toBeInstanceOf(FakeSock);   // the PC comes back to the same room
    const pcBack = r.state.all.at(-1)!;
    pcBack.close(1001); await left(r.host, 'pc', pcBack, 4000);
    await tick(r.host, 4000 + IDLE_MS);
    expect(r.state.meta).toHaveProperty('gone');
  });

  it('unpairs from either side: both are told and closed, and the room is wiped', async () => {
    for (const from of ['pc', 'phone'] as const) {
      const r = fakeRoom();
      const pc = await r.join('pc') as FakeSock;
      const phone = await r.join('phone') as FakeSock;
      await frame(r.host, from, from === 'pc' ? pc : phone, '{"t":"unpair"}', 1);
      for (const s of [pc, phone]) {
        expect(s.texts.at(-1)).toBe('{"t":"unpaired"}');
        expect(s.closed).toBe(CLOSE.unpaired);
      }
      expect(r.state.meta).toHaveProperty('gone');
      expect(JSON.stringify(r.state.meta)).not.toContain('token');   // a hash of the token, not the token
      expect(r.state.alarm).toBeUndefined();
      expect(await r.join('phone')).toBe(CLOSE.gone);
    }
  });

  it('never opens an unpaired or expired room again, whoever asks and with whatever token', async () => {
    const r = fakeRoom();
    const pc = await r.join('pc') as FakeSock;
    await r.join('phone');
    await frame(r.host, 'pc', pc, '{"t":"unpair"}', 1);
    expect(await r.join('pc', 'token', 2)).toBe(CLOSE.gone);        // the PC that made it, with the old token
    expect(await r.join('pc', 'other', 3)).toBe(CLOSE.gone);        // or anyone with a new one
    expect(await r.join('phone', 'token', 4)).toBe(CLOSE.gone);
    expect(r.host.socks()).toEqual([]);
    await tick(r.host, 5 + IDLE_MS);                                // the alarm leaves the mark alone
    expect(r.state.meta).toHaveProperty('gone');

    const unused = fakeRoom();                                      // a QR nobody scanned in time
    await unused.join('pc');
    await tick(unused.host, UNUSED_MS);
    expect(await unused.join('pc', 'token', UNUSED_MS + 1)).toBe(CLOSE.gone);
  });

  it('belongs to the first phone: another phone is refused, the same one may come back', async () => {
    const r = fakeRoom();
    const pc = await r.join('pc') as FakeSock;
    expect(await admit(r.host, 'phone', 'token', 0)).toBe(CLOSE.badAuth);   // a phone must name itself
    const phone = await r.join('phone', 'token', 1, 'phone-1') as FakeSock;
    expect(await r.join('phone', 'token', 2, 'phone-2')).toBe(CLOSE.taken);   // someone else with the same QR link
    expect(phone.closed).toBeUndefined();                                     // the paired phone is not pushed out
    expect(r.host.socks('phone')).toEqual([phone]);
    const again = await r.join('phone', 'token', 3, 'phone-1') as FakeSock;   // the same phone reloads the page
    expect(phone.closed).toBe(CLOSE.taken);
    expect(r.host.socks('phone')).toEqual([again]);
    phone.close(1001); again.close(1001);
    await left(r.host, 'phone', again, 4);
    expect(await r.join('phone', 'token', 5, 'phone-2')).toBe(CLOSE.taken);   // still refused when the phone is away
    expect(await r.join('phone', 'token', 6, 'phone-1')).toBeInstanceOf(FakeSock);
    expect(pc.closed).toBeUndefined();
  });

  it('caps the size and the rate of frames', async () => {
    const r = fakeRoom();
    const pc = await r.join('pc') as FakeSock;
    const phone = await r.join('phone') as FakeSock;
    await frame(r.host, 'phone', phone, bytes(MAX_BYTES), 0);
    expect(phone.closed).toBeUndefined();
    await frame(r.host, 'phone', phone, bytes(MAX_BYTES + 1), 0);
    expect(phone.closed).toBe(CLOSE.tooBig);

    const before = phone.got.length;
    for (let i = 0; i < RATE.frames; i++) await frame(r.host, 'pc', pc, bytes(1), 0);
    expect(pc.closed).toBeUndefined();
    await frame(r.host, 'pc', pc, bytes(1), RATE.ms - 1);
    expect(pc.closed).toBe(CLOSE.rate);
    expect(phone.got.length).toBe(before);   // the phone socket was closed above, so nothing reached it

    // A new window allows frames again.
    const r2 = fakeRoom();
    const pc2 = await r2.join('pc') as FakeSock;
    for (let i = 0; i < RATE.frames; i++) await frame(r2.host, 'pc', pc2, bytes(1), 0);
    await frame(r2.host, 'pc', pc2, bytes(1), RATE.ms);
    expect(pc2.closed).toBeUndefined();
  });
});
