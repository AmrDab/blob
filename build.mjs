// Builds into dist/: the UI (the React bundle, the page, onnxruntime-web's wasm, served locally, not from a CDN) and
// the files MCP server that Claude Code starts with Node.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/ort', { recursive: true });
await build({
  entryPoints: ['src/ui/main.tsx'],
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
cpSync('src/ui/index.html', 'dist/index.html');
cpSync('src/ui/style.css', 'dist/style.css');
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `dist/ort/${f}`);
}
