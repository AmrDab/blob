// Reports from Blob (src/report.ts): after a mistake, with the user's Yes, Blob posts a report of the request here.
// They are kept private: anyone can post one (within limits), and only the developers read them, with the
// REPORTS_KEY secret (`wrangler secret put REPORTS_KEY`). No address of the sender is kept, only a hash of it for
// the hour's limit. Plain logic over a small store, tested in test/reports.test.ts; the Durable Object is index.ts.

export const MAX_TEXT = 8000;
export const MAX_TITLE = 120;
/** Reports kept: past this the oldest go. */
export const KEEP = 2000;
/** Reports from one sender in an hour, and from everyone in a day. */
export const PER_HOUR = 5;
export const PER_DAY = 500;
const HOUR = 3600_000, DAY = 24 * HOUR;

export interface Report { id: number; t: number; title: string; text: string; version: string }

export interface Store {
  add(r: Omit<Report, 'id'>, who: string): Promise<void>;
  /** How many reports this sender (or anyone, with who undefined) posted since `since`. */
  count(since: number, who?: string): Promise<number>;
  list(limit: number): Promise<Report[]>;
  remove(id: number): Promise<void>;
  trim(keep: number): Promise<void>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A sender's hash: the hour's limit needs to tell senders apart, never to know who they are. */
export async function senderHash(address: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`blob-report:${address}`));
  return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** POST: keep a report. */
export async function post(store: Store, body: unknown, who: string, now: number): Promise<Response> {
  const b = (body ?? {}) as Record<string, unknown>;
  const t = text(b.text, MAX_TEXT + 1);
  if (!t.trim()) return json({ ok: false, error: 'empty' }, 400);
  if (t.length > MAX_TEXT) return json({ ok: false, error: 'too long' }, 413);
  if (await store.count(now - HOUR, who) >= PER_HOUR || await store.count(now - DAY) >= PER_DAY) {
    return json({ ok: false, error: 'too many' }, 429);
  }
  await store.add({ t: now, title: text(b.title, MAX_TITLE), text: t, version: text(b.version, 40) }, who);
  await store.trim(KEEP);
  return json({ ok: true });
}

/** The developers' key, compared in constant time. False when no key is set: then nobody can read. */
export function authorized(header: string | null, key: string | undefined): boolean {
  if (!key) return false;
  const want = new TextEncoder().encode(`Bearer ${key}`), got = new TextEncoder().encode(header ?? '');
  if (want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
  return diff === 0;
}

/** GET (the newest first) and DELETE ?id=: the developers only. Anyone else gets "not found". */
export async function read(store: Store, method: string, url: URL, auth: string | null, key: string | undefined): Promise<Response> {
  if (!authorized(auth, key)) return new Response('Not found', { status: 404 });
  if (method === 'DELETE') {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isInteger(id)) return json({ ok: false, error: 'id' }, 400);
    await store.remove(id);
    return json({ ok: true });
  }
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  return json({ ok: true, reports: await store.list(limit) });
}
