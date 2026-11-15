// Builds the theblob website into site/dist (static files, ready for Cloudflare Pages).
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const out = join(here, 'dist');
mkdirSync(join(out, 'fonts'), { recursive: true });
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
cpSync(join(here, 'index.html'), join(out, 'index.html'));
cpSync(join(here, 'style.css'), join(out, 'style.css'));
cpSync(join(here, '..', 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'), join(out, 'fonts/inter-latin-wght-normal.woff2'));
