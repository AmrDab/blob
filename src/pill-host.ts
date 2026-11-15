// The relay clawdcursor starts in place of its own pill (CLAWD_PILL_CMD, set in brain.ts), once per form: with no
// arguments for the running pill, again with --paused for the card (whose content is in the environment). It keeps
// one request open to Blob's local server: the body is the pill's state and then every stdin line, the response is
// Blob's answer, written to stdout. Blob shows the pill for as long as that request lives, so the pill closes when
// stdin closes and also when clawdcursor kills this process.
// It leaves only when stdin closes or after an answer: clawdcursor takes an early exit with nothing said as a broken
// pill and draws its own from then on. While Blob can't be reached it keeps trying.
import { request } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { pillState } from './pill.ts';

export function relay(o: {
  url?: string; token?: string; env: Record<string, string | undefined>;
  stdin: Readable; stdout: Writable; exit: (code: number) => void; retryMs?: number;
}): void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let req: ReturnType<typeof request> | undefined;
  const exit = (code: number) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    req?.destroy();
    o.exit(code);
  };
  // stdin closed: clawdcursor is gone. Ending the request closes the pill; leave even if Blob never answers that.
  let closed = false;
  o.stdin.on('end', () => { closed = true; if (!req) exit(0); else setTimeout(() => exit(0), 500); });
  o.stdin.resume();
  const connect = () => {
    if (done || !o.url || !o.token) return;          // never named: wait for stdin to close
    let answered = false, over = false;
    const r = req = request(o.url, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-pill-token': o.token } }, res => {
      res.on('data', d => { if (res.statusCode === 200) { answered = true; o.stdout.write(d); } });
      res.on('close', again);
    });
    function again() {                               // Blob closed it: after an answer that is the end, else try again
      if (over) return;
      over = true;
      o.stdin.unpipe(r);
      o.stdin.resume();                              // keep reading, to see stdin close while waiting
      r.destroy();
      if (req === r) req = undefined;
      if (answered || closed) exit(0);
      else if (!done) timer = setTimeout(connect, o.retryMs ?? 1000);
    }
    r.on('error', again);
    r.setNoDelay(true);                              // HIDE must not wait: a click follows 90 ms later
    r.write(JSON.stringify(pillState(o.env)) + '\n');
    o.stdin.pipe(r);
  };
  connect();
}

export function main(): void {
  relay({
    url: process.env.BLOB_PILL_URL, token: process.env.BLOB_PILL_TOKEN, env: process.env,
    stdin: process.stdin, stdout: process.stdout,
    exit: code => process.stdout.write('', () => process.exit(code)),   // after the answer is flushed
  });
}
