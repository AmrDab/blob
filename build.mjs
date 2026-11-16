// Builds into dist/: the UI (the React bundles, the pages, onnxruntime-web's wasm, served locally, not from a CDN),
// the files, self and desk MCP servers that Claude Code starts with Node, the desk's PowerShell bridge, and the pill
// relay that clawdcursor starts with Node.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/ort', { recursive: true });
await build({
  entryPoints: ['src/ui/main.tsx', 'src/ui/pill.tsx'],   // the bubble, and clawdcursor's pill
  outdir: 'dist',
  bundle: true,
  splitting: true,          // speech (transformers + onnxruntime) loads only when Speak is first used
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});
await build({
  stdin: { contents: "import { serve } from './src/files-mcp.ts'; void serve();", resolveDir: import.meta.dirname, loader: 'ts' },
  outfile: 'dist/files-mcp.mjs',
  bundle: true,
  packages: 'external',     // the SDK and koffi load from node_modules
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
});
// Blob's self server ("blob"): Claude Code starts it with Node, like the files server.
await build({
  stdin: { contents: "import { serve } from './src/self-mcp.ts'; void serve();", resolveDir: import.meta.dirname, loader: 'ts' },
  outfile: 'dist/self-mcp.mjs',
  bundle: true,
  packages: 'external',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
});
// Blob's desk server ("desk"): it passes each call on to the main process, which runs the bridge beside it.
await build({
  stdin: { contents: "import { serve } from './src/desk-mcp.ts'; void serve();", resolveDir: import.meta.dirname, loader: 'ts' },
  outfile: 'dist/desk-mcp.mjs',
  bundle: true,
  packages: 'external',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
});
cpSync('src/desk-bridge.ps1', 'dist/desk-bridge.ps1');
// The pill relay clawdcursor starts with Node in place of its own pill (brain.ts): Node built-ins only.
await build({
  stdin: { contents: "import { main } from './src/pill-host.ts'; main();", resolveDir: import.meta.dirname, loader: 'ts' },
  outfile: 'dist/pill-host.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
});
cpSync('src/ui/index.html', 'dist/index.html');
cpSync('src/ui/pill.html', 'dist/pill.html');
cpSync('src/ui/style.css', 'dist/style.css');
cpSync('site/fonts', 'dist/fonts', { recursive: true });   // Fraunces, Geist, Geist Mono (latin + latin-ext) and their licence: the website's own
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `dist/ort/${f}`);
}
