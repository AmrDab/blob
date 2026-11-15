// Builds the phone page into phone/dist (static files: the Worker in relay/ serves them, or Cloudflare Pages).
// BLOB_RELAY=wss://host sets the relay when it is not on the page's own host.
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
  define: { __RELAY__: JSON.stringify(process.env.BLOB_RELAY ?? '') },
  logLevel: 'warning',
});
cpSync(join(here, 'index.html'), join(out, 'index.html'));
cpSync(join(here, 'style.css'), join(out, 'style.css'));
for (const f of ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2']) {
  cpSync(join(here, '..', 'node_modules/@fontsource-variable/inter/files', f), join(out, 'fonts', f));
}
