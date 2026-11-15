// Blob's web view processes, named to clawdcursor as its own UI. A fake process list; a temp file only.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepOwnUiFile, webviewPids, type Proc } from '../src/own-ui.ts';

const BLOB = 100;
const procs = (): Proc[] => [
  { pid: BLOB, parent: 1, name: 'node.exe' },
  { pid: 200, parent: BLOB, name: 'msedgewebview2.exe' },      // the web view's browser process
  { pid: 201, parent: 200, name: 'msedgewebview2.exe' },       // a renderer: the cards' buttons live here
  { pid: 202, parent: 200, name: 'MSEdgeWebView2.EXE' },       // the GPU process
  { pid: 300, parent: BLOB, name: 'claude.exe' },              // Blob's child, but not its UI
  { pid: 301, parent: 300, name: 'node.exe' },                 // clawdcursor
  { pid: 302, parent: 301, name: 'msedgewebview2.exe' },       // some other app's web view, started by the agent
  { pid: 400, parent: 1, name: 'msedgewebview2.exe' },         // another app's web view
  { pid: 401, parent: 400, name: 'msedgewebview2.exe' },
];

describe("Blob's own UI processes", () => {
  it("are the web view's processes under Blob, at any depth, and nobody else's", () => {
    expect(webviewPids(procs(), BLOB)).toEqual([200, 201, 202]);
    expect(webviewPids(procs(), 999)).toEqual([]);
    expect(webviewPids([{ pid: 5, parent: 5, name: 'msedgewebview2.exe' }], 5)).toEqual([]);   // a loop in the list ends
  });

  describe('the file clawdcursor reads', () => {
    let dir = '', file = '';
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blob-ownui-')); file = join(dir, 'own-ui-pids'); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('is written at once, follows the processes as they change, and comes back when it is removed', async () => {
      let list = procs();
      const stop = keepOwnUiFile(file, () => list, BLOB, 10);
      expect(readFileSync(file, 'utf8')).toBe('200,201,202');
      list = [...list.filter(p => p.pid !== 201), { pid: 250, parent: 200, name: 'msedgewebview2.exe' }];   // a renderer was replaced
      await sleep(60);
      expect(readFileSync(file, 'utf8')).toBe('200,202,250');
      rmSync(file);
      await sleep(60);
      expect(readFileSync(file, 'utf8')).toBe('200,202,250');
      stop();
      rmSync(file);
      await sleep(60);
      expect(existsSync(file)).toBe(false);
    });

    it('does nothing where the processes cannot be listed', () => {
      keepOwnUiFile(file, undefined)();
      expect(existsSync(file)).toBe(false);
    });
  });
});
