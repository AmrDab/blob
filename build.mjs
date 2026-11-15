// Builds the UI into dist/: the React bundle, the page, and onnxruntime-web's wasm (served locally, not from a CDN).
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
cpSync('src/ui/index.html', 'dist/index.html');
cpSync('src/ui/style.css', 'dist/style.css');
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `dist/ort/${f}`);
}
