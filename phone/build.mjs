// Builds the phone page into phone/dist/phone: it is served at /phone/ (by the Worker in relay/, or by the site on
// Cloudflare Pages, which copies it in `npm run build:site`).
// BLOB_RELAY=wss://host sets the relay when it is not on the page's own host.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const out = join(here, 'dist', 'phone');
mkdirSync(join(out, 'fonts'), { recursive: true });
await build({
  entryPoints: [join(here, 'main.tsx')],
  outfile: join(out, 'main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  define: { __RELAY__: JSON.stringify(process.env.BLOB_RELAY ?? '') },
  logLevel: 'warning',
});
cpSync(join(here, 'index.html'), join(out, 'index.html'));
cpSync(join(here, 'style.css'), join(out, 'style.css'));
cpSync(join(here, '..', 'site', 'fonts'), join(out, 'fonts'), { recursive: true });   // Fraunces, Geist, Geist Mono and their licence
