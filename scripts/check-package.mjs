// Proves a packed theblob works the way a user gets it: installed from the .tgz into an empty folder, it passes
// `theblob --check` (the native parts load) and each MCP server answers tools/list with no SDK installed.
//   node scripts/check-package.mjs release/npm/theblob-<version>.tgz
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tgz = resolve(process.argv[2] ?? '');
const dir = mkdtempSync(join(tmpdir(), 'theblob-check-'));
// npm is a .cmd shim on Windows, which only cmd can start
const npm = (args) => execFileSync(process.platform === 'win32' ? 'cmd' : 'npm', process.platform === 'win32' ? ['/c', 'npm', ...args] : args, { cwd: dir, stdio: 'inherit' });
try {
  npm(['init', '-y']);
  npm(['install', '--no-audit', '--no-fund', tgz]);
  const pkg = join(dir, 'node_modules', 'theblob');
  console.log(execFileSync(process.execPath, [join(pkg, 'cli.js'), '--check'], { encoding: 'utf8' }).trim());
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map(m => JSON.stringify(m)).join('\n') + '\n';
  for (const server of ['files-mcp', 'self-mcp', 'desk-mcp']) {
    const r = spawnSync(process.execPath, [join(pkg, 'dist', `${server}.mjs`)], { input: lines, encoding: 'utf8', timeout: 20_000 });
    const list = r.stdout.split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } }).find(m => m?.id === 2);
    if (!list?.result?.tools?.length) throw new Error(`${server} gave no tools: ${(r.stdout + r.stderr).slice(0, 400)}`);
    console.log(`${server}: ${list.result.tools.length} tools`);
  }
  console.log('package ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
