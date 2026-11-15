// The pairing room's rules, kept apart from the Durable Object so they can be tested offline.
// The room only forwards binary frames (ciphertext) between one PC and one phone; it cannot read them.

export type Role = 'pc' | 'phone';
export interface Sock { send(data: string | ArrayBuffer): void; close(code?: number, reason?: string): void }
/** `auth` is the room's access token, set by the PC that creates the room. `phone` is the first phone's device id. */
export interface Live { auth: string; created: number; paired: boolean; seen: number; phone?: string }
/** What is left of a room that was unpaired or expired: a hash of its token, so the room is never opened again. */
export interface Gone { gone: string }
export type Meta = Live | Gone;
export interface Host {
  meta(): Promise<Meta | undefined>;
  save(meta: Meta): Promise<void>;
  wipe(): Promise<void>;                 // the stored room and its alarm
  alarm(at: number): Promise<void>;
  socks(role?: Role): Sock[];            // the open sockets (not the ones being closed)
}

export const CLOSE = { unpaired: 4000, rate: 4008, badAuth: 4403, gone: 4404, taken: 4409, tooBig: 1009 } as const;
export const UNUSED_MS = 10 * 60_000;          // a room no phone joined
export const IDLE_MS = 30 * 24 * 3600_000;     // a paired room nobody connected to
export const MAX_BYTES = 64 * 1024;            // one frame
export const RATE = { frames: 40, ms: 10_000 };   // per socket

const other = (role: Role): Role => (role === 'pc' ? 'phone' : 'pc');
const say = (s: Sock, msg: object) => { try { s.send(JSON.stringify(msg)); } catch { /* closing */ } };
const shut = (s: Sock, code: number, reason: string) => { try { s.close(code, reason); } catch { /* closed */ } };
/** Ends a joined socket: it is told why in a text frame first, so it need not wait for the close to arrive. */
const drop = (s: Sock, why: 'unpaired' | 'expired' | 'replaced', code: number) => { say(s, { t: why }); shut(s, code, why); };
const isGone = (m: Meta | undefined): m is Gone => !!m && 'gone' in m;

async function hash(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decides whether a new socket may join: 0, or the code to close it with. The first PC creates the room, once: a room
 * that was unpaired or expired stays closed. The first phone to join is the room's phone (by its device id, `dev`):
 * no other phone gets in after it. A newcomer takes the place of an older socket of its own (a reload, or a
 * connection that died without closing).
 */
export async function admit(h: Host, role: Role, auth: string, now: number, dev?: string): Promise<number> {
  let meta = await h.meta();
  if (isGone(meta)) return CLOSE.gone;
  if (meta && !meta.paired && now >= meta.created + UNUSED_MS) { await expire(h, meta); return CLOSE.gone; }
  if (!meta) {
    if (role !== 'pc') return CLOSE.gone;
    meta = { auth, created: now, paired: false, seen: now };
    await h.alarm(now + UNUSED_MS);
  }
  if (meta.auth !== auth) return CLOSE.badAuth;
  if (role === 'phone') {
    if (!dev) return CLOSE.badAuth;
    if (meta.phone && meta.phone !== dev) return CLOSE.taken;   // another phone: the one that is paired stays
    meta.phone = dev;
    meta.paired = true;
  }
  for (const old of h.socks(role)) drop(old, 'replaced', CLOSE.taken);
  meta.seen = now;
  await h.save(meta);
  return 0;
}

/** After the socket is accepted: each side learns whether the other one is there. */
export function entered(h: Host, role: Role, sock: Sock): void {
  const peers = h.socks(other(role));
  say(sock, { t: 'peer', on: peers.length > 0 });
  for (const p of peers) say(p, { t: 'peer', on: true });
}

const counts = new WeakMap<Sock, { from: number; n: number }>();

/** A frame from a socket: binary is forwarded as it is; the only text frame is `{"t":"unpair"}`. */
export async function frame(h: Host, role: Role, sock: Sock, data: string | ArrayBuffer, now: number): Promise<void> {
  const size = typeof data === 'string' ? data.length : data.byteLength;
  if (size > MAX_BYTES) return shut(sock, CLOSE.tooBig, 'frame too big');
  let c = counts.get(sock);
  if (!c || now - c.from >= RATE.ms) counts.set(sock, c = { from: now, n: 0 });
  if (++c.n > RATE.frames) return shut(sock, CLOSE.rate, 'too many frames');
  if (typeof data === 'string') {
    let t: unknown;
    try { t = JSON.parse(data).t; } catch { /* not ours */ }
    if (t === 'unpair') await unpair(h);
    return;
  }
  for (const p of h.socks(other(role))) { try { p.send(data); } catch { /* closing */ } }
}

export async function left(h: Host, role: Role, sock: Sock, now: number): Promise<void> {
  if (!h.socks(role).some(s => s !== sock)) for (const p of h.socks(other(role))) say(p, { t: 'peer', on: false });
  const meta = await h.meta();
  if (meta && !isGone(meta)) await h.save({ ...meta, seen: now });
}

/** The room is over: nothing about it is kept but the mark that it was, so its id can't be used to make it again. */
async function bury(h: Host, meta: Live): Promise<void> {
  await h.wipe();
  await h.save({ gone: await hash(meta.auth) });
}

/** Unpair: both sides are told and closed. */
export async function unpair(h: Host): Promise<void> {
  for (const s of h.socks()) drop(s, 'unpaired', CLOSE.unpaired);
  const meta = await h.meta();
  if (meta && !isGone(meta)) await bury(h, meta);
}

async function expire(h: Host, meta: Live): Promise<void> {
  for (const s of h.socks()) drop(s, 'expired', CLOSE.gone);
  await bury(h, meta);
}

/** The alarm: closes a room no phone joined in time, and a paired room nobody used for a long time. */
export async function tick(h: Host, now: number): Promise<void> {
  const meta = await h.meta();
  if (!meta || isGone(meta)) return;
  if (!meta.paired) return now >= meta.created + UNUSED_MS ? expire(h, meta) : h.alarm(meta.created + UNUSED_MS);
  if (h.socks().length) return h.alarm(now + IDLE_MS);
  return now >= meta.seen + IDLE_MS ? bury(h, meta) : h.alarm(meta.seen + IDLE_MS);
}
