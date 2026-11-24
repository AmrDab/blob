#!/usr/bin/env node
// Reads Blob's private reports from the relay (relay/src/reports.ts), newest first. Developers only:
//   BLOB_REPORTS_KEY=<the REPORTS_KEY secret> node scripts/reports.mjs [limit]
//   BLOB_REPORTS_KEY=… node scripts/reports.mjs --delete <id>
// BLOB_RELAY: another relay than https://theblob.pages.dev.
const key = process.env.BLOB_REPORTS_KEY;
if (!key) { console.error('Set BLOB_REPORTS_KEY to the relay\'s REPORTS_KEY secret.'); process.exit(1); }
const relay = (process.env.BLOB_RELAY ?? 'https://theblob.pages.dev').replace(/\/+$/, '');
const headers = { authorization: `Bearer ${key}` };
const [a, b] = process.argv.slice(2);
if (a === '--delete') {
  const r = await fetch(`${relay}/reports?id=${encodeURIComponent(b ?? '')}`, { method: 'DELETE', headers });
  console.log(r.ok ? `Deleted ${b}.` : `Failed: ${r.status}`);
  process.exit(r.ok ? 0 : 1);
}
const r = await fetch(`${relay}/reports?limit=${Number(a) || 50}`, { headers });
if (!r.ok) { console.error(`Failed: ${r.status} (wrong key, or the relay has no REPORTS_KEY)`); process.exit(1); }
const { reports } = await r.json();
if (!reports.length) console.log('No reports.');
for (const x of reports) console.log(`#${x.id} · ${new Date(x.t).toISOString()} · ${x.version || '?'} · ${x.title}\n${x.text}\n${'─'.repeat(60)}`);
