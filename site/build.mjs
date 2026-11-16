// Builds the theblob website into site/dist (static files, ready for Cloudflare Pages), with the phone page at /phone/.
import '../phone/build.mjs';
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, 'main.tsx')],
  outfile: join(out, 'main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});
for (const f of ['index.html', 'style.css', 'favicon.svg', 'og.png']) {
  if (existsSync(join(here, f))) cpSync(join(here, f), join(out, f), { recursive: true });
}
// the fonts the site's style.css names (latin only: the latin-ext files are the app's and the phone page's), and their licence
mkdirSync(join(out, 'fonts'), { recursive: true });
for (const f of ['fraunces-latin-full-normal.woff2', 'geist-latin-wght-normal.woff2', 'geist-mono-latin-wght-normal.woff2', 'LICENSE.txt']) {
  cpSync(join(here, 'fonts', f), join(out, 'fonts', f));
}
cpSync(join(here, '..', 'phone', 'dist', 'phone'), join(out, 'phone'), { recursive: true });
