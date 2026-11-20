// The private reports store on the relay (relay/src/reports.ts), over an in-memory store.
import { describe, expect, it } from 'vitest';
import { KEEP, MAX_TEXT, PER_DAY, PER_HOUR, authorized, post, read, senderHash, type Report, type Store } from '../relay/src/reports.ts';

function memory(): Store & { all: (Report & { who: string })[] } {
  const all: (Report & { who: string })[] = [];
  let next = 1;
  return {
    all,
    add: async (r, who) => { all.push({ ...r, id: next++, who }); },
    count: async (since, who) => all.filter(r => r.t >= since && (who === undefined || r.who === who)).length,
    list: async limit => all.slice().reverse().slice(0, limit).map(({ who: _w, ...r }) => r),
    remove: async id => { const i = all.findIndex(r => r.id === id); if (i >= 0) all.splice(i, 1); },
    trim: async keep => { all.splice(0, Math.max(0, all.length - keep)); },
  };
}
const KEY = 'secret-key-for-the-developers';
const url = (q = '') => new URL(`https://theblob.pages.dev/reports${q}`);

describe('private reports', () => {
  it('keeps a report, with no address of the sender', async () => {
    const s = memory();
    const r = await post(s, { title: 'Report: x', text: 'what went wrong', version: '0.1.1' }, await senderHash('203.0.113.9'), 1000);
    expect(r.status).toBe(200);
    expect(s.all).toHaveLength(1);
    expect(s.all[0]).toMatchObject({ title: 'Report: x', text: 'what went wrong', version: '0.1.1', t: 1000 });
    expect(JSON.stringify(s.all)).not.toContain('203.0.113.9');
  });

  it('refuses an empty or too long one', async () => {
    const s = memory();
    expect((await post(s, { text: '  ' }, 'a', 0)).status).toBe(400);
    expect((await post(s, { text: 'x'.repeat(MAX_TEXT + 1) }, 'a', 0)).status).toBe(413);
    expect((await post(s, null, 'a', 0)).status).toBe(400);
    expect(s.all).toHaveLength(0);
  });

  it('takes a few an hour from one sender and a few hundred a day from everyone', async () => {
    const s = memory();
    for (let i = 0; i < PER_HOUR; i++) expect((await post(s, { text: 't' }, 'a', i)).status).toBe(200);
    expect((await post(s, { text: 't' }, 'a', PER_HOUR)).status).toBe(429);
    expect((await post(s, { text: 't' }, 'b', PER_HOUR)).status).toBe(200);        // someone else
    expect((await post(s, { text: 't' }, 'a', 3600_000 + 10)).status).toBe(200);   // an hour later
    const busy = memory();
    for (let i = 0; i < PER_DAY; i++) await busy.add({ t: i, title: '', text: 't', version: '' }, `s${i}`);
    expect((await post(busy, { text: 't' }, 'new', PER_DAY)).status).toBe(429);
  });

  it(`keeps the newest ${KEEP}`, async () => {
    const s = memory();
    for (let i = 0; i < KEEP; i++) await s.add({ t: -1e10, title: '', text: `r${i}`, version: '' }, 'x');   // long ago
    await post(s, { text: 'the newest' }, 'y', 1);
    expect(s.all).toHaveLength(KEEP);
    expect(s.all[0].text).toBe('r1');
    expect(s.all.at(-1)!.text).toBe('the newest');
  });

  it('is read only with the developers\' key: anyone else gets "not found"', async () => {
    const s = memory();
    await post(s, { text: 'one' }, 'a', 1);
    await post(s, { text: 'two' }, 'a', 2);
    expect((await read(s, 'GET', url(), null, KEY)).status).toBe(404);
    expect((await read(s, 'GET', url(), 'Bearer wrong', KEY)).status).toBe(404);
    expect((await read(s, 'GET', url(), `Bearer ${KEY}`, undefined)).status).toBe(404);   // no key set: nobody reads
    const ok = await read(s, 'GET', url(), `Bearer ${KEY}`, KEY);
    expect(ok.status).toBe(200);
    expect((await ok.json() as { reports: Report[] }).reports.map(r => r.text)).toEqual(['two', 'one']);
    expect((await read(s, 'DELETE', url('?id=1'), `Bearer ${KEY}`, KEY)).status).toBe(200);
    expect(s.all.map(r => r.text)).toEqual(['two']);
    expect((await read(s, 'DELETE', url('?id=1'), 'Bearer wrong', KEY)).status).toBe(404);
  });

  it('compares the key whole', () => {
    expect(authorized(`Bearer ${KEY}`, KEY)).toBe(true);
    expect(authorized(`Bearer ${KEY}x`, KEY)).toBe(false);
    expect(authorized(`Bearer ${KEY.slice(0, -1)}`, KEY)).toBe(false);
    expect(authorized('', '')).toBe(false);
  });
});
