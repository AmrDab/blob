// Assembles the `theblob` npm package in release/npm, so `npx theblob` runs Blob with Node 24 and nothing else:
// no clone, no install step, no build. Run after `node build.mjs`:
//   node scripts/pack.mjs && cd release/npm && npm pack
// The package holds Blob's main process (one bundle), the built dist/ and a small cli.js. Only the two native addons
// stay outside the bundle; npm installs each one's prebuilt binary for the user's system.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'release', 'npm');
const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const NATIVE = ['koffi', '@webviewjs/webview'];

for (const f of ['index.html', 'main.js', 'files-mcp.mjs', 'self-mcp.mjs', 'desk-mcp.mjs', 'pill-host.mjs', 'desk-bridge.ps1']) {
  if (!existsSync(join(root, 'dist', f))) { console.error(`dist/${f} is missing: run node build.mjs first`); process.exit(1); }
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// app/main.mjs: main.ts finds the UI and the servers at ../dist from its own folder, as it does from src/.
await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(out, 'app', 'main.mjs'),
  bundle: true,
  external: NATIVE,
  banner: { js: "import { createRequire as __blobRequire } from 'node:module'; const require = __blobRequire(import.meta.url);" },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  logLevel: 'warning',
});
cpSync(join(root, 'dist'), join(out, 'dist'), { recursive: true });
cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });   // the icons of the entry Blob is opened from (launcher.ts)
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

writeFileSync(join(out, 'cli.js'), `#!/usr/bin/env node
// theblob: starts Blob. --version prints the version; --check loads the native parts and exits (no window).
import { existsSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const arg = process.argv[2];
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(\`Blob needs Node.js 24 or newer; this is \${process.version}. Get it from https://nodejs.org\`);
  process.exit(1);
}
if (arg === '--version' || arg === '-v') console.log(version);
else if (arg === '--check') {
  await import('koffi');
  await import('@webviewjs/webview');
  const missing = ['app/main.mjs', 'dist/index.html', 'dist/files-mcp.mjs', 'dist/self-mcp.mjs', 'dist/desk-mcp.mjs', 'dist/pill-host.mjs']
    .filter(f => !existsSync(new URL(\`./\${f}\`, import.meta.url)));
  if (missing.length) { console.error(\`theblob \${version}: missing \${missing.join(', ')}\`); process.exit(1); }
  console.log(\`theblob \${version} ok on \${process.platform}-\${process.arch}\`);
} else await import('./app/main.mjs');
`);

writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'theblob',
  version: app.version,
  description: 'Blob: a tiny floating bubble. Tell your computer what to do, by voice or text, with your own Claude Code or Codex.',
  license: app.license,
  type: 'module',
  bin: { theblob: 'cli.js' },
  dependencies: Object.fromEntries(NATIVE.map(n => [n, app.dependencies[n]])),
  files: ['cli.js', 'app', 'dist', 'assets', 'LICENSE', 'README.md'],
  engines: { node: '>=24' },
  os: ['win32', 'darwin'],
  repository: { type: 'git', url: 'https://github.com/AmrDab/blob.git' },
  homepage: 'https://github.com/AmrDab/blob#readme',
  keywords: ['assistant', 'desktop', 'voice', 'claude', 'codex'],
}, null, 2) + '\n');

writeFileSync(join(out, 'README.md'), `# theblob

Blob is a tiny floating bubble: tell your computer what to do, by voice or text. It runs your own Claude Code or
Codex. Windows and macOS. Needs [Node.js](https://nodejs.org) 24 or newer.

\`\`\`
npx theblob
\`\`\`

The first start shows what is still missing (Claude Code or Codex, the sign-in, the permissions) as cards to tap.
Keep the terminal open while Blob runs; Ctrl+C stops it. To keep it installed: \`npm install -g theblob\`, then \`theblob\`.

More: https://github.com/AmrDab/blob
`);
console.log(`theblob@${app.version} assembled in ${out}`);
