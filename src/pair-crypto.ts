// Phone pairing: the end-to-end crypto and the message types the PC and the phone page share.
// WebCrypto only (no Node imports), so the phone page bundles this file too.

/** What the phone sends to the PC. */
export type PhoneMsg =
  | { t: 'req'; id: string; text: string }                                       // a spoken or typed request
  | { t: 'reply'; id: string; yes?: boolean; choice?: string; text?: string }    // the answer to an ask
  | { t: 'stop' };                                                               // stop the running task

/** What the PC sends to the phone. */
export type PcMsg =
  | { t: 'status'; state: 'ready' | 'working'; text?: string }
  | { t: 'answer'; text: string; id?: string }                                   // shown and read aloud
  | { t: 'ask'; id: string; question: string; choices?: string[]; input?: boolean }   // no choices = Yes / No
  | { t: 'ask-done'; id: string };                                               // answered on the PC

/** What the relay itself says (text frames; ciphertext is binary frames). The last three come just before it closes. */
export type RelayMsg = { t: 'peer'; on: boolean } | { t: 'unpaired' | 'expired' | 'replaced' };

/** The relay's close codes. */
export const CLOSE = { unpaired: 4000, rate: 4008, badAuth: 4403, gone: 4404, taken: 4409 } as const;

export type Side = 'pc' | 'phone';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomB64url(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Reads `#r=<room>&k=<secret>` from the QR link. */
export function parseFragment(hash: string): { room: string; secret: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const room = p.get('r') ?? '', secret = p.get('k') ?? '';
  return /^[\w-]{22}$/.test(room) && /^[\w-]{43}$/.test(secret) ? { room, secret } : null;
}

export interface Channel {
  /** The room's access token for the relay. It is derived from the secret but cannot decrypt anything. */
  auth: string;
  seal(msg: object): Promise<ArrayBuffer>;
  /** Throws on a wrong key, a changed frame, or a frame that was already seen (a replay). */
  open(frame: ArrayBuffer): Promise<any>;
}

/**
 * Keys from the one-time secret with HKDF-SHA-256 (salt: the room id): one AES-256-GCM key per direction and the
 * relay token. A frame is a 12-byte random nonce followed by the ciphertext of `{ n, ...msg }`; `n` only goes up.
 */
export async function channel(secret: string, room: string, side: Side): Promise<Channel> {
  const base = await crypto.subtle.importKey('raw', unb64url(secret), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(room), info: enc.encode(info) });
  const key = (from: Side) => crypto.subtle.deriveKey(hkdf(`blob-pair ${from}`), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const [out, inn, auth] = await Promise.all([
    key(side), key(side === 'pc' ? 'phone' : 'pc'), crypto.subtle.deriveBits(hkdf('blob-pair auth'), base, 128),
  ]);
  let sent = 0, seen = 0;
  // One at a time, in call order: frames leave and are read in the order of their `n`.
  let line: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(job: () => Promise<T>): Promise<T> => {
    const done = line.then(job);
    line = done.catch(() => {});
    return done;
  };
  return {
    auth: b64url(new Uint8Array(auth)),
    seal: msg => inOrder(async () => {
      sent = Math.max(sent + 1, Date.now());   // still goes up after a restart or a page reload
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, out, enc.encode(JSON.stringify({ ...msg, n: sent })));
      const frame = new Uint8Array(12 + data.byteLength);
      frame.set(iv);
      frame.set(new Uint8Array(data), 12);
      return frame.buffer;
    }),
    open: frame => inOrder(async () => {
      const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: frame.slice(0, 12) }, inn, frame.slice(12));
      const { n, ...msg } = JSON.parse(dec.decode(data));
      if (typeof n !== 'number' || n <= seen) throw new Error('replayed frame');
      seen = n;
      return msg;
    }),
  };
}
