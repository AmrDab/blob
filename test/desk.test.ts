// The desk's tools on a fake bridge (canned replies), and the bridge's process on fake streams. No desktop and no
// PowerShell: nothing is read, pressed or started.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { outcomeOf } from '../src/brain.ts';
import { AI_HOSTS, Bridge, DOWN, deskTools, isAiHost, needsYes, ownPids, refusal, type Meta } from '../src/desk.ts';
import { forward } from '../src/desk-mcp.ts';

const OWN = 1;                                         // Blob's own process in these tests
const win = (hwnd: number, app: string, title: string, o: object = {}) =>
  ({ hwnd, title, pid: 1000 + hwnd, app, cls: 'Win', minimized: false, elevated: false, hung: false, ...o });
const node = (id: string, role: string, name: string, o: object = {}) =>
  ({ id, depth: 0, parent: '', role, name, actions: [] as string[], enabled: true, offscreen: false, password: false, focused: false, pid: 1010, help: '', aid: '', ...o });
const notepad = win(10, 'Notepad', 'notes.txt - Notepad');
const save = node('e1', 'Button', 'Save', { actions: ['press'] });
const meta = (o: Partial<Meta> = {}): Meta => ({
  hwnd: 10, pid: 1010, wpid: 1010, app: 'Notepad', elevated: false, role: 'Button', name: 'Save', help: '', aid: '',
  actions: ['press'], enabled: true, password: false, focused: false, windowTitle: 'notes.txt - Notepad', windowText: '', ...o,
});
const outcome = (r: { text: string; isError: boolean }) => outcomeOf(r.text, r.isError).outcome;

type Reply = object | ((cmd: any) => object);
/** The tools on a bridge that answers each command with what the test gives it. */
function desk(o: { windows?: object[]; fg?: number; read?: Reply; act?: Reply; value?: Reply; open?: Reply; yes?: boolean; own?: number[] } = {}) {
  const asked: { question: string; detail?: string }[] = [], logs: string[] = [];
  const state = { own: new Set(o.own ?? [OWN]) };
  const canned: Record<string, Reply> = {
    windows: { ok: true, fg: o.fg ?? 0, windows: o.windows ?? [notepad] },
    read: o.read ?? { ok: true, nodes: [save] },
    act: o.act ?? { ok: true, changed: ['Saved'], opened: [], closed: 0, gone: false, fgChanged: false, cursorMoved: false },
    value: o.value ?? { ok: true, value: 'text' },
    open: o.open ?? { ok: true, app: 'Calculator' },
  };
  const call = vi.fn(async (cmd: any) => { const r = canned[cmd.cmd]; return typeof r === 'function' ? r(cmd) : r; });
  const t = deskTools({ bridge: { call }, ask: async (question, detail) => { asked.push({ question, detail }); return o.yes ?? true; }, own: () => state.own, log: s => logs.push(s) });
  const sent = (name: string) => call.mock.calls.map(c => c[0]).filter(c => c.cmd === name);
  return { t, call, sent, asked, logs, state };
}
/** Reads one window with these nodes, then acts on them. */
async function acting(nodes: object[], o: Parameters<typeof desk>[0] = {}) {
  const d = desk({ ...o, read: { ok: true, nodes } });
  await d.t.read({ window: 'w10' });
  return d;
}

describe('read with no arguments', () => {
  it('lists the windows, without Blob\'s own and without AI assistants', async () => {
    const d = desk({ own: [OWN, 77], windows: [
      win(10, 'Notepad', 'notes.txt - Notepad', { minimized: true }),
      win(11, 'regedit', 'Registry Editor', { elevated: true }),
      win(12, 'mspaint', 'Untitled - Paint', { hung: true }),
      win(13, 'node', 'Blob', { pid: OWN }),                                   // Blob's window
      win(14, 'msedgewebview2', 'Blob card', { cls: 'ApplicationFrameWindow', pid: 77 }),   // by the process a frame hosts
      win(15, 'Claude.exe', 'Claude'),
      win(16, 'Code - Insiders', 'main.ts'),
    ] });
    const r = await d.t.read({});
    expect(r.text).toBe('w10 Notepad "notes.txt - Notepad" minimized\nw11 regedit "Registry Editor" admin\nw12 mspaint "Untitled - Paint" not responding');
    expect(outcome(r)).toBe('ok');
    expect(d.sent('read')).toEqual([]);
  });

  it('shows 60 at most, and says so when none is left', async () => {
    const many = await desk({ windows: Array.from({ length: 61 }, (_, i) => win(100 + i, 'app', `Window ${i}`)) }).t.read({});
    expect(many.text.split('\n')).toHaveLength(61);
    expect(many.text).toMatch(/\nw159 app "Window 59"\n… 1 more$/);
    expect((await desk({ windows: [win(13, 'node', 'Blob', { pid: OWN })] }).t.read({})).text).toBe('No windows are open.');
  });
});

describe('read with app', () => {
  const windows = [notepad, win(11, 'Notepad', 'todo.txt - Notepad'), win(12, 'CalculatorApp', 'Calculator')];

  it('reads the one window that matches, by app name or title, any case', async () => {
    const d = desk({ windows });
    expect((await d.t.read({ app: 'calc' })).text).toBe('w12 CalculatorApp "Calculator"\n  e1 Button "Save" (press)');
    expect((await d.t.read({ app: 'TODO' })).text).toMatch(/^w11 /);
    expect(d.sent('read').map(c => c.hwnd)).toEqual([12, 11]);
  });

  it('lists them when several match, and fails when none does', async () => {
    const d = desk({ windows });
    expect((await d.t.read({ app: 'notepad' })).text).toBe('w10 Notepad "notes.txt - Notepad"\nw11 Notepad "todo.txt - Notepad"');
    expect((await d.t.read({ app: 'excel' })).text).toBe('[failed · STALE · hint: no open window matches "excel"; open it, or read with no arguments]');
    expect(d.sent('read')).toEqual([]);
  });
});

describe('read with window', () => {
  it('refuses Blob itself, an AI assistant and an admin app, and fails on a frozen or closed one, without reading', async () => {
    const d = desk({ windows: [
      win(13, 'node', 'Blob', { pid: OWN }), win(15, 'claude', 'Claude'), win(11, 'regedit', 'Registry Editor', { elevated: true }),
      win(12, 'mspaint', 'Untitled - Paint', { hung: true }),
    ] });
    expect((await d.t.read({ window: 'w13' })).text).toBe('[refused · OWN_UI · hint: that is Blob itself]');
    expect((await d.t.read({ window: 'w15' })).text).toBe("[refused · AI_HOST · hint: Blob never works an AI assistant's window]");
    expect((await d.t.read({ window: 'w11' })).text).toBe("[refused · ELEVATED · hint: it runs as administrator; Blob can't control it, tell the user]");
    expect((await d.t.read({ window: 'w12' })).text).toBe('[failed · NOT_RESPONDING · hint: the app is not responding; tell the user]');
    expect((await d.t.read({ window: 'w99' })).text).toBe('[failed · STALE · hint: that window is gone; read with no arguments]');
    expect(d.sent('read')).toEqual([]);
    const gone = await desk({ read: { ok: false, code: 'STALE' } }).t.read({ window: 'w10' });
    expect(gone.text).toBe('[failed · STALE · hint: that window is gone; read with no arguments]');
  });

  it('shows the controls as an indented tree: what each can do, its state, and no password', async () => {
    const r = await desk({ read: { ok: true, nodes: [
      node('e3', 'MenuBar', 'Application'),
      node('e4', 'MenuItem', 'File', { depth: 1, actions: ['press', 'expand', 'collapse'], state: 'collapsed' }),
      node('e7', 'Button', 'Save', { actions: ['press'] }),
      node('e9', 'Edit', 'File name', { value: 'draft.txt', actions: ['set'], focused: true }),
      node('e10', 'CheckBox', 'Word wrap', { actions: ['toggle'], state: 'on' }),
      node('e11', 'Edit', 'Password', { value: 'hunter2', actions: ['set'], password: true }),
      node('e12', 'Button', 'Old\n  one', { actions: ['press'], enabled: false, offscreen: true }),
      node('e13', 'Text', ''),
    ] } }).t.read({ window: 'w10' });
    expect(r.text).toBe([
      'w10 Notepad "notes.txt - Notepad"',
      '  e3 MenuBar "Application"',
      '    e4 MenuItem "File" collapsed (press, expand, collapse)',
      '  e7 Button "Save" (press)',
      '  e9 Edit "File name" = "draft.txt" (set) focused',
      '  e10 CheckBox "Word wrap" on (toggle)',
      '  e11 Edit "Password" (set) password',
      '  e12 Button "Old one" (press) disabled offscreen',
      '  e13 Text',
    ].join('\n'));
    expect(outcome(r)).toBe('ok');
  });

  it('shows 300 lines at most, and marks a partial walk', async () => {
    const nodes = Array.from({ length: 301 }, (_, i) => node(`e${i + 1}`, 'Text', `Line ${i}`));
    const r = await desk({ read: { ok: true, nodes, truncated: true } }).t.read({ window: 'w10' });
    const lines = r.text.split('\n');
    expect(lines).toHaveLength(303);
    expect(lines.slice(-3)).toEqual(['  e300 Text "Line 299"', '… 1 more; pass find to narrow', '(partial: the window is large; pass find)']);
  });

  it('with find, lists the matches flat, each with where it is', async () => {
    const d = desk({ read: cmd => ({ ok: true, nodes: cmd.find === 'zzz' ? [] : [node('e5', 'Button', 'Save', { depth: 3, parent: 'Toolbar', actions: ['press'] }), node('e6', 'MenuItem', 'Save as', { depth: 2 })] }) });
    expect((await d.t.read({ window: 'w10', find: ' save ' })).text).toBe('w10 Notepad "notes.txt - Notepad"\ne5 Button "Save" (press) in "Toolbar"\ne6 MenuItem "Save as"');
    expect(d.sent('read')[0]).toEqual({ cmd: 'read', hwnd: 10, find: 'save' });
    expect((await d.t.read({ window: 'w10', find: 'zzz' })).text).toBe('w10 Notepad "notes.txt - Notepad"\nNothing in it matches "zzz".');
    const many = await desk({ read: { ok: true, nodes: Array.from({ length: 51 }, (_, i) => node(`e${i + 1}`, 'Text', `Save ${i}`)) } }).t.read({ window: 'w10', find: 'save' });
    expect(many.text.split('\n').slice(-2)).toEqual(['e50 Text "Save 49"', '… 1 more']);
  });

  it('fails as EMPTY when the window shows nothing, or only a browser\'s own bar', async () => {
    const none = await desk({ read: { ok: true, nodes: [] } }).t.read({ window: 'w10' });
    expect(none.text).toBe('[failed · EMPTY · hint: this window shows nothing to the background tools (a minimized Store app sleeps); use the screen tools]');
    const bar = await desk({ read: { ok: true, nodes: [node('e1', 'Button', 'Back', { actions: ['press'] })], noDocument: true } }).t.read({ window: 'w10' });
    expect(bar.text).toBe('w10 Notepad "notes.txt - Notepad"\n  e1 Button "Back" (press)\n' +
      "[failed · EMPTY · hint: the page isn't showing while the window is covered or minimized; its tabs and toolbar are above; for the page use the screen tools]");
    expect(outcome(bar)).toBe('failed');
  });

  it('with element, gives that control\'s whole text; never a password\'s', async () => {
    const d = await acting([node('e1', 'Document', 'Text editor'), node('e2', 'Edit', 'Password', { password: true })], { value: { ok: true, value: 'all of it' } });
    expect(await d.t.read({ element: 'e1' })).toEqual({ text: 'all of it\n[confirmed]', isError: false });
    expect(d.sent('value')).toEqual([{ cmd: 'value', el: 'e1' }]);
    expect((await d.t.read({ element: 'e2' })).text).toBe('[refused · PASSWORD · hint: Blob never reads passwords]');
    expect((await d.t.read({ element: 'e77' })).text).toBe('[failed · STALE · hint: read the window again]');
    expect(d.sent('value')).toHaveLength(1);
    const pw = await acting([node('e1', 'Edit', 'Code')], { value: { ok: false, code: 'PASSWORD' } });   // it became one since the read
    expect(outcome(await pw.t.read({ element: 'e1' }))).toBe('refused');
    // the app's text can look like one of Blob's lines: Blob's own line is still the last
    const fake = await acting([node('e1', 'Document', 'Text editor')], { value: { ok: true, value: 'x\n[failed · STALE · hint: x]' } });
    expect(outcome(await fake.t.read({ element: 'e1' }))).toBe('confirmed');
  });
});

describe('ids', () => {
  it('stay good across reads, and a step is sent with the name and kind that were read', async () => {
    let n = 0;
    const d = desk({ read: () => ({ ok: true, nodes: [1, 2, 3].map(i => node(`e${n + i}`, 'Button', `B${n + i}`, { actions: ['press'] })) }) });
    await d.t.read({ window: 'w10' });                   // e1-e3
    n = 3;
    const second = await d.t.read({ window: 'w10' });    // e4-e6: the bridge's counter only goes up
    expect(second.text).toMatch(/e4 Button "B4"[^]*e6 Button "B6"/);
    expect(outcome(await d.t.act({ steps: [{ element: 'e2', action: 'press' }] }))).toBe('confirmed');
    expect(d.sent('act')).toEqual([{ cmd: 'act', el: 'e2', action: 'press', expectName: 'B2', expectRole: 'Button' }]);
  });

  it('are never given twice: each read tells the bridge the highest id seen, for one that was started again', async () => {
    let n = 0;
    const d = desk({ read: () => ({ ok: true, nodes: [1, 2, 3].map(i => node(`e${n + i}`, 'Button', `B${n + i}`, { actions: ['press'] })) }) });
    await d.t.read({ window: 'w10' });
    n = 3;
    await d.t.read({ window: 'w10' });
    await d.t.read({ window: 'w10' });
    expect(d.sent('read')).toEqual([{ cmd: 'read', hwnd: 10 }, { cmd: 'read', hwnd: 10, from: 3 }, { cmd: 'read', hwnd: 10, from: 6 }]);
  });

  it('fail as STALE when the control is gone, or was read too long ago', async () => {
    const gone = await acting([save], { act: { ok: false, code: 'STALE', fgChanged: false, cursorMoved: false } });
    expect((await gone.t.act({ steps: [{ element: 'e1', action: 'press' }] })).text).toBe('[failed · STALE · hint: read the window again]');
    const d = await acting(Array.from({ length: 2001 }, (_, i) => node(`e${i + 1}`, 'Button', `B${i + 1}`, { actions: ['press'] })));
    expect((await d.t.act({ steps: [{ element: 'e1', action: 'press' }] })).text).toBe('[failed · STALE · hint: read the window again]');   // only 2000 are kept
    expect(d.sent('act')).toEqual([]);
    expect(outcome(await d.t.act({ steps: [{ element: 'e2', action: 'press' }] }))).toBe('confirmed');
  });
});

describe('a step that cannot run', () => {
  const own = new Set([OWN]), press = { element: 'e7', action: 'press' };
  const text = (m: Meta | undefined, step = press, pids = own) => refusal(step, m, pids)?.text;

  it('is refused for Blob itself, an AI assistant, an admin app and a password field', () => {
    expect(text(undefined)).toBe('[failed · STALE · hint: read the window again]');
    expect(text(meta({ wpid: OWN }))).toBe('[refused · OWN_UI · hint: that is Blob itself]');            // the window's process (a Store frame: the app it hosts)
    expect(text(meta({ pid: 201 }), press, new Set([OWN, 201]))).toBe('[refused · OWN_UI · hint: that is Blob itself]');   // the control's own process
    expect(text(meta({ app: 'Codex.exe' }))).toBe("[refused · AI_HOST · hint: Blob never works an AI assistant's window]");
    expect(text(meta({ elevated: true }))).toBe("[refused · ELEVATED · hint: it runs as administrator; Blob can't control it, tell the user]");
    expect(text(meta({ password: true, actions: ['set'] }), { element: 'e7', action: 'set' })).toBe('[refused · PASSWORD · hint: the user types passwords themselves]');
    expect(text(meta({ wpid: OWN, elevated: true, password: true }))).toMatch(/OWN_UI/);                 // in that order
  });

  it('fails when the control is disabled, cannot do that, or a set has no value', () => {
    expect(text(meta({ enabled: false }))).toBe('[failed · DISABLED · hint: e7 is disabled now]');
    expect(text(meta({ actions: ['toggle', 'press'] }), { element: 'e7', action: 'set' })).toBe('[failed · NO_PATTERN · hint: e7 can only toggle, press; if none fits, use the screen tools]');
    expect(text(meta({ actions: [] }))).toBe('[failed · NO_PATTERN · hint: e7 can only be read; if none fits, use the screen tools]');
    expect(text(meta({ actions: ['set'] }), { element: 'e7', action: 'set' })).toBe('[failed · NO_PATTERN · hint: set needs a value]');
    expect(refusal({ element: 'e7', action: 'set', value: '' } as any, meta({ actions: ['set'] }), own)).toBeNull();
    expect(text(meta())).toBeUndefined();
  });

  it('stops the whole batch before anything runs', async () => {
    const d = await acting([save, node('e2', 'Button', 'Print', { actions: ['press'], enabled: false })]);
    const r = await d.t.act({ steps: [{ element: 'e1', action: 'press' }, { element: 'e2', action: 'press' }] });
    expect(r.text).toBe('[failed · DISABLED · hint: e2 is disabled now]');
    expect(d.sent('act')).toEqual([]);
    expect(outcome(await d.t.act({ steps: [] }))).toBe('failed');
    expect(outcome(await d.t.act({ steps: Array(11).fill({ element: 'e1', action: 'press' }) }))).toBe('failed');
  });

  it('is refused when the window became Blob\'s own after it was read', async () => {
    const d = await acting([save]);
    d.state.own = new Set([OWN, 1010]);
    expect((await d.t.act({ steps: [{ element: 'e1', action: 'press' }] })).text).toBe('[refused · OWN_UI · hint: that is Blob itself]');
    expect((await d.t.read({ element: 'e1' })).text).toBe('[refused · OWN_UI · hint: that is Blob itself]');
    expect(d.sent('act')).toEqual([]);
  });
});

describe('the Yes card', () => {
  const press = { element: 'e1', action: 'press' };
  const card = (m: Partial<Meta>, step: object = press, fg?: number) => needsYes({ ...press, ...step }, meta(m), fg);

  it('asks before a press that sends, deletes, pays or installs, by its name, tooltip or id', () => {
    expect(card({ name: 'Send' })).toEqual({ question: 'Press "Send" in Notepad?' });
    for (const name of ['Delete draft', 'Don’t Save', "Don't Save", 'Don‘t Save', 'Donʼt Save', 'Do not save', 'Close without saving', 'Check out', 'Sign out',
      '&Uninstall', 'Unsubscribe', 'Run anyway', 'Restart now', 'End task', 'Clear browsing data', 'Log off', 'Deleting…', 'Sends now']) expect(card({ name }), name).not.toBeNull();
    expect(card({ name: '', help: 'Delete message' })).toEqual({ question: 'Press "Button" in Notepad?' });
    for (const aid of ['deleteButton', 'btn_send', 'SENDButton', 'delete2']) expect(card({ name: 'X', aid }), aid).not.toBeNull();
    expect(card({ name: 'Clear' })).toBeNull();                                            // Calculator's C
  });

  it('asks before a press on a file that runs', () => {
    for (const name of ['ChromeSetup.exe', 'tool.ps1', 'Setup']) expect(card({ role: 'ListItem', name }), name).toEqual({ question: `Press "${name}" in Notepad?` });
    expect(card({ role: 'ListItem', name: 'notes.txt' })).toBeNull();
    // Explorer hides extensions: "invoice" may be invoice.exe, so every item there asks; its tree pane does not
    for (const role of ['ListItem', 'DataItem']) expect(card({ app: 'explorer', role, name: 'invoice' }), role).toEqual({ question: 'Press "invoice" in explorer?' });
    expect(card({ app: 'explorer', role: 'TreeItem', name: 'Documents' })).toBeNull();
  });

  it('asks before any press in a security prompt, and before run, enable content, keep or trust', () => {
    for (const box of [{ windowTitle: 'Open File - Security Warning' }, { windowTitle: 'Windows protected your PC' }, { windowTitle: 'Book1 - Excel', windowText: 'PROTECTED VIEW Be careful' },
      { windowTitle: 'Word', windowText: 'SECURITY WARNING Macros have been disabled.' }]) expect(card({ name: 'More info', ...box }), box.windowTitle).toEqual({ question: 'Press "More info" in Notepad?', detail: expect.any(String) });
    for (const name of ['Run', 'Enable Content', 'Enable Editing', 'Keep', 'Trust', 'Open anyway']) expect(card({ name }), name).not.toBeNull();
    // not only a press: a box ticked or an option picked in a security prompt asks too
    for (const action of ['toggle', 'select', 'expand']) expect(card({ name: 'Always ask', windowTitle: 'Open File - Security Warning' }, { action }), action).not.toBeNull();
  });

  it('asks before Explorer\'s own Open, which opens the selected item', () => {
    for (const [role, name] of [['Button', 'Open'], ['MenuItem', 'Open with'], ['SplitButton', 'Open']]) expect(card({ app: 'explorer', role, name }), name).not.toBeNull();
    expect(card({ role: 'Button', name: 'Open' })).toBeNull();                              // another app's Open is judged as before
  });

  it('asks before a bare OK when the window\'s title says what it does, and shows the title', () => {
    expect(card({ name: 'OK', windowTitle: 'Permanently delete 40 items?' })).toEqual({ question: 'Press "OK" in Notepad?', detail: 'Permanently delete 40 items?' });
    expect(card({ name: '', windowTitle: 'Confirm Save As' })?.detail).toBe('Confirm Save As');
    expect(card({ name: 'Open', windowTitle: 'Delete me.txt - Notepad' })).toBeNull();     // the button says what it does: the title is not asked
    expect(card({ name: 'OK', windowTitle: 'About Notepad' })).toBeNull();
  });

  it('asks before a bare OK, Yes or No when the box\'s own text says what it does', () => {
    expect(card({ name: 'OK', windowTitle: 'Microsoft Excel', windowText: 'Permanently delete this sheet?' }))
      .toEqual({ question: 'Press "OK" in Notepad?', detail: 'Microsoft Excel Permanently delete this sheet?' });
    expect(card({ name: 'No', windowTitle: 'Notepad', windowText: 'Do you want to save changes to Untitled?' })).not.toBeNull();
    expect(card({ name: 'Continue', windowTitle: 'Shop', windowText: 'This can’t be undone.' })).not.toBeNull();
    expect(card({ name: 'No', windowTitle: 'Notepad', windowText: 'Word wrap is on.' })).toBeNull();
    expect(card({ name: 'Open', windowTitle: 'Notepad', windowText: 'Delete everything?' })).toBeNull();   // only a button that says nothing
  });

  it('keeps the box\'s text from the read', async () => {
    const d = desk({ read: { ok: true, nodes: [node('e1', 'Button', 'OK', { actions: ['press'] })], text: 'Permanently delete\nthis sheet?' } });
    await d.t.read({ window: 'w10' });
    await d.t.act({ steps: [{ element: 'e1', action: 'press' }] });
    expect(d.asked).toEqual([{ question: 'Press "OK" in Notepad?', detail: 'notes.txt - Notepad Permanently delete this sheet?' }]);
  });

  it('asks before a press the model marked, and before a link (with where it goes)', () => {
    expect(card({ name: 'Senden' }, { consequential: true })).toEqual({ question: 'Press "Senden" in Notepad?' });
    expect(card({ name: 'Senden' }, { consequential: 'true' })).toBeNull();
    expect(card({ role: 'Hyperlink', name: 'Read more', value: 'https://example.com/a' })).toEqual({ question: 'Open the link "Read more" in Notepad?', detail: 'https://example.com/a' });
    expect(card({ role: 'Hyperlink', name: 'x', value: 'h'.repeat(700) })?.detail).toHaveLength(600);
  });

  it('asks before replacing text in the field the user is in, and only then', () => {
    const set = { action: 'set', value: 'x' }, field = { role: 'Edit', name: 'To', actions: ['set'] };
    expect(card({ ...field, focused: true }, set, 10)).toEqual({ question: 'Replace what\'s in "To" in Notepad?' });
    expect(card({ ...field, focused: true }, set, 99)).toBeNull();                        // another window is in front
    expect(card({ ...field, focused: false }, set, 10)).toBeNull();
    expect(card({ ...field, name: 'Delete', focused: false }, set, 10)).toBeNull();       // a set is not judged by its name
  });

  it('asks before a toggle or a select by its name, and before any step the model marked but a collapse', () => {
    expect(card({ name: 'Allow apps to access your location' }, { action: 'toggle' })).toEqual({ question: 'Switch "Allow apps to access your location" in Notepad?' });
    expect(card({ name: 'Pay with saved card' }, { action: 'select' })).toEqual({ question: 'Select "Pay with saved card" in Notepad?' });
    expect(card({ name: 'I agree' }, { action: 'toggle', consequential: true })).not.toBeNull();
    expect(card({ name: 'More' }, { action: 'expand', consequential: true })).toEqual({ question: 'Open "More" in Notepad?' });
  });

  it('never asks for a plain press, toggle or select, for an expand by its name, or for a collapse', () => {
    expect(card({ name: 'Bold' })).toBeNull();
    for (const action of ['toggle', 'select']) expect(card({ name: 'Word wrap' }, { action }), action).toBeNull();
    expect(card({ name: 'Format' }, { action: 'expand' })).toBeNull();                     // a menu only opens
    expect(card({ name: 'Delete' }, { action: 'collapse', consequential: true })).toBeNull();
  });

  it('is one line, with each of the app\'s words cut to 60 characters', () => {
    const c = card({ name: `Delete\r\n${'x'.repeat(100)}`, app: `a\n${'p'.repeat(100)}` })!;
    expect(c.question).not.toMatch(/[\r\n]/);
    expect(c.question).toBe(`Press "Delete ${'x'.repeat(52)}…" in a ${'p'.repeat(57)}…?`);
    expect(card({ name: 'OK', windowTitle: `Delete\n${'t'.repeat(300)}` })!.detail).toHaveLength(200);
  });

  it('asks once, then presses on Yes', async () => {
    const d = await acting([node('e1', 'Button', 'Send', { actions: ['press'] })]);
    expect(outcome(await d.t.act({ steps: [{ element: 'e1', action: 'press' }] }))).toBe('confirmed');
    expect(d.asked).toEqual([{ question: 'Press "Send" in Notepad?', detail: undefined }]);
    expect(d.sent('act')).toHaveLength(1);
  });

  it('on No presses nothing, and the batch stops there', async () => {
    const d = await acting([save, node('e2', 'Button', 'Delete', { actions: ['press'] }), node('e3', 'Button', 'Close', { actions: ['press'] })], { yes: false });
    const r = await d.t.act({ steps: [{ element: 'e1', action: 'press' }, { element: 'e2', action: 'press' }, { element: 'e3', action: 'press' }] });
    expect(r.text).toBe('Pressed "Save". Now: Saved.\n[refused · USER_SAID_NO · hint: the user said No; leave it]');
    expect(outcome(r)).toBe('refused');
    expect(d.asked).toHaveLength(1);
    expect(d.sent('act').map(c => c.el)).toEqual(['e1']);
  });

  it('asks for a set only when its window is in front and its field has the keyboard', async () => {
    const field = node('e1', 'Edit', 'To', { actions: ['set'], focused: true, value: 'a' });
    const act = { ok: true, before: 'a', after: 'b', fgChanged: false, cursorMoved: false };
    const front = await acting([field], { fg: 10, act });
    await front.t.act({ steps: [{ element: 'e1', action: 'set', value: 'b' }] });
    expect(front.asked).toEqual([{ question: 'Replace what\'s in "To" in Notepad?', detail: undefined }]);
    const behind = await acting([field], { fg: 55, act });
    await behind.t.act({ steps: [{ element: 'e1', action: 'set', value: 'b' }] });
    expect(behind.asked).toEqual([]);
    const idle = await acting([{ ...field, focused: false }], { fg: 10, act });
    await idle.t.act({ steps: [{ element: 'e1', action: 'set', value: 'b' }] });
    expect(idle.asked).toEqual([]);
    expect(idle.sent('windows')).toHaveLength(1);       // the read's own; the front window is only looked up for a focused field
  });
});

describe('what a step says', () => {
  const quiet = { fgChanged: false, cursorMoved: false };
  const one = async (n: object, step: object, act: object, o: object = {}) => {
    const d = await acting([n], { ...o, act: { ...quiet, ...act } });
    const r = await d.t.act({ steps: [{ element: 'e1', ...step }] });
    return { ...d, r, text: r.text, outcome: outcome(r) };
  };
  const button = node('e1', 'Button', 'One', { actions: ['press'] });
  const field = node('e1', 'Edit', 'File name', { actions: ['set'], value: 'old' });
  const box = node('e1', 'CheckBox', 'Word wrap', { actions: ['toggle'], state: 'off' });
  const menu = node('e1', 'MenuItem', 'File', { actions: ['expand', 'collapse'] });
  const press = { action: 'press' };

  it('for a press: what changed, what opened, or that nothing did', async () => {
    expect((await one(button, press, { ok: true, changed: ['Display is 1'], opened: [], closed: 0, gone: false })).text).toBe('Pressed "One". Now: Display is 1.\n[confirmed]');
    expect((await one(button, press, { ok: true, changed: [], opened: [{ hwnd: 5512, title: 'Save as' }], closed: 0, gone: false })).text).toBe('Pressed "One". A window "Save as" opened: w5512.\n[confirmed]');
    expect((await one(button, press, { ok: true, changed: [], opened: [], closed: 0, gone: true })).text).toBe('Pressed "One".\n[confirmed]');
    expect((await one(button, press, { ok: true, changed: [], opened: [], closed: 1, gone: false })).outcome).toBe('confirmed');
    const same = await one(button, press, { ok: true, changed: [], opened: [], closed: 0, gone: false });
    expect(same.text).toBe('Pressed "One".\n[unverified · hint: nothing visible changed; read the window to check]');
    expect(same.r.isError).toBe(false);
    const busy = await one(button, press, { ok: true, pending: true });
    expect(busy.text).toBe('Pressed "One"; the app is still busy (a box may have opened).\n[unverified · hint: read with no arguments to see what opened]');
  });

  it('for a set: confirmed when it reads back, unverified when it reads something else, failed when it did not move', async () => {
    const set = { action: 'set', value: 'x' };
    expect((await one(field, set, { ok: true, before: 'old', after: 'x' })).text).toBe('Set "File name" to "x".\n[confirmed]');
    expect((await one(field, set, { ok: true, before: 'old', after: 'X.txt' })).text).toBe('[unverified · hint: it now reads "X.txt"]');
    expect((await one(field, set, { ok: true, before: 'old', after: 'old' })).text).toBe('[failed · DID_NOTHING · hint: it still reads "old"; use the screen tools]');
    expect((await one(field, { action: 'set', value: 'old' }, { ok: true, before: 'old', after: 'old' })).outcome).toBe('confirmed');   // it already said that
    const combo = await one(field, set, { ok: false, code: 'NOT_IN_BACKGROUND' });
    expect(combo.text).toBe('[failed · NOT_IN_BACKGROUND · hint: this field takes typing only; use the screen tools]');
    expect(combo.sent('act')[0]).toEqual({ cmd: 'act', el: 'e1', action: 'set', value: 'x', expectName: 'File name', expectRole: 'Edit' });
  });

  it('for a toggle, a select and an expand: confirmed only when the state was reached', async () => {
    const toggle = { action: 'toggle' }, select = { action: 'select' };
    expect((await one(box, toggle, { ok: true, before: 'Off', after: 'On' })).text).toBe('"Word wrap" is now on.\n[confirmed]');
    expect((await one(box, toggle, { ok: true, before: 'Off', after: 'Off' })).text).toBe('[failed · DID_NOTHING · hint: it is still off; use the screen tools]');
    const item = node('e1', 'ListItem', 'Inbox', { actions: ['select'] });
    expect((await one(item, select, { ok: true, selected: true })).text).toBe('Selected "Inbox".\n[confirmed]');
    expect((await one(item, select, { ok: true, selected: false })).outcome).toBe('failed');
    expect((await one(menu, { action: 'expand' }, { ok: true, before: 'Collapsed', after: 'Expanded' })).text).toBe('Expanded "File".\n[confirmed]');
    expect((await one(menu, { action: 'collapse' }, { ok: true, before: 'Expanded', after: 'Collapsed' })).text).toBe('Collapsed "File".\n[confirmed]');
    expect((await one(menu, { action: 'expand' }, { ok: true, before: 'Collapsed', after: 'Collapsed' })).text).toBe('[failed · NOT_IN_BACKGROUND · hint: this menu opens only in front; use the screen tools]');
    expect((await one(menu, { action: 'expand' }, { ok: false, code: 'NOT_IN_BACKGROUND', message: 'x' })).text).toBe('[failed · NOT_IN_BACKGROUND · hint: this menu opens only in front; use the screen tools]');
  });

  it('for a classic control that only works in front, and for a toggle, a select or a set that opened a box', async () => {
    expect((await one(button, press, { ok: false, code: 'NOT_IN_BACKGROUND' })).text).toBe('[failed · NOT_IN_BACKGROUND · hint: this control works only in front; use the screen tools]');
    expect((await one(box, { action: 'toggle' }, { ok: true, pending: true })).text).toBe('Switched "Word wrap"; the app is still busy (a box may have opened).\n[unverified · hint: read with no arguments to see what opened]');
    expect((await one(field, { action: 'set', value: 'x' }, { ok: true, pending: true })).text).toMatch(/^Set "File name"; the app is still busy/);
    expect((await one(node('e1', 'ListItem', 'Inbox', { actions: ['select'] }), { action: 'select' }, { ok: true, pending: true })).outcome).toBe('unverified');
  });

  it('for the bridge\'s own failures: their code', async () => {
    expect((await one(button, press, { ok: false, code: 'NOT_RESPONDING' })).text).toBe('[failed · NOT_RESPONDING · hint: the app is not responding; tell the user]');
    expect((await one(button, press, { ok: false, code: 'CANT_PRESS', message: 'Access\ndenied' })).text).toBe('[failed · CANT_PRESS · hint: Access denied; read the window again, or use the screen tools]');
    const d = desk({ act: () => { throw new Error('no answer in 15 s'); } });
    await d.t.read({ window: 'w10' });
    const r = await d.t.act({ steps: [{ element: 'e1', action: 'press' }] });
    expect(r.text).toBe('[failed · BRIDGE · no answer in 15 s · hint: use the screen tools]');
    expect(outcome(r)).toBe('failed');
  });

  it('is unverified when another window came to the front; a moved pointer is only noted', async () => {
    const changed = { ok: true, changed: ['Display is 1'], opened: [], closed: 0, gone: false };
    const front = await one(button, press, { ...changed, fgChanged: true });
    expect(front.text).toBe('Pressed "One". Now: Display is 1.\n[unverified · hint: another window came to the front during this step]');
    expect(front.logs).toEqual(['Blob: desk act changed the window in front']);
    const failedToo = await one(button, press, { ok: false, code: 'CANT_PRESS', message: 'no', fgChanged: true });
    expect(failedToo.outcome).toBe('failed');             // a failure stays a failure
    const moved = await one(button, press, { ...changed, cursorMoved: true });
    expect(moved.outcome).toBe('confirmed');
    expect(moved.logs).toEqual(['Blob: the pointer moved during a desk act']);
  });

  it('passes on an earlier press that failed late', async () => {
    const late = await one(button, press, { ok: true, changed: ['Display is 1'], opened: [], closed: 0, gone: false, lateError: 'The dialog\nwas cancelled' });
    expect(late.text).toBe('(An earlier press failed: The dialog was cancelled.) Pressed "One". Now: Display is 1.\n[confirmed]');
  });

  it('runs a batch in order and stops at the first step that did not confirm', async () => {
    const keys = ['One', 'Plus', 'Two', 'Equals'].map((name, i) => node(`e${i + 1}`, 'Button', name, { actions: ['press'] }));
    const all = await acting(keys, { act: cmd => ({ ok: true, changed: [`Display is ${cmd.el}`], opened: [], closed: 0, gone: false, ...quiet }) });
    const steps = keys.map(k => ({ element: k.id, action: 'press' }));
    expect((await all.t.act({ steps })).text).toBe(
      'Pressed "One". Now: Display is e1.\nPressed "Plus". Now: Display is e2.\nPressed "Two". Now: Display is e3.\nPressed "Equals". Now: Display is e4.\n[confirmed]');
    const part = await acting(keys, { act: cmd => ({ ok: true, changed: cmd.el === 'e2' ? [] : ['Display is 1'], opened: [], closed: 0, gone: false, ...quiet }) });
    const r = await part.t.act({ steps });
    expect(r.text).toBe('Pressed "One". Now: Display is 1.\nPressed "Plus".\n[unverified · hint: nothing visible changed; read the window to check]');
    expect(outcome(r)).toBe('unverified');
    expect(part.sent('act').map(c => c.el)).toEqual(['e1', 'e2']);
  });
});

describe('a request that ended', () => {
  const steps = [{ element: 'e1', action: 'press' }, { element: 'e2', action: 'press' }];
  const two = [save, node('e2', 'Button', 'Send', { actions: ['press'] })];

  it('presses nothing more', async () => {
    const d = await acting(two);
    const r = await d.t.act({ steps }, () => d.sent('act').length > 0);   // it ended during the first step
    expect(r.text).toBe('Pressed "Save". Now: Saved.\n[unverified · hint: the request ended; the rest was not done]');
    expect(d.sent('act').map(c => c.el)).toEqual(['e1']);
    expect(d.asked).toEqual([]);
  });

  it('does not press on a Yes that came after it ended', async () => {
    const d = await acting(two);
    const r = await d.t.act({ steps: [steps[1]] }, () => d.asked.length > 0);
    expect(outcome(r)).toBe('unverified');
    expect(d.sent('act')).toEqual([]);
  });
});

describe('open', () => {
  const open = async (reply: object) => { const d = desk({ open: reply }); const r = await d.t.open({ app: ' calc ' }); return { ...d, r, text: r.text }; };

  it('starts a Start menu app and gives back its window', async () => {
    const found = await open({ ok: true, app: 'Calculator', window: { hwnd: 8844, title: 'Calculator' } });
    expect(found.text).toBe('Opened Calculator: w8844 "Calculator".\n[confirmed]');
    expect(found.sent('open')).toEqual([{ cmd: 'open', name: 'calc' }]);
    const later = await open({ ok: true, app: 'Calculator' });
    expect(later.text).toBe('Opened Calculator.\n[unverified · hint: read with app to find its window]');
    expect(later.r.isError).toBe(false);
  });

  it('fails on a name that fits several apps or none, and refuses an installer', async () => {
    expect((await open({ ok: false, code: 'AMBIGUOUS', names: ['Calculator', 'Calendar'] })).text).toBe('[failed · AMBIGUOUS · hint: did you mean Calculator, Calendar?]');
    expect((await open({ ok: false, code: 'NOT_FOUND', names: ['Calendar'] })).text).toBe('[failed · NOT_FOUND · hint: no Start menu app by that name (close: Calendar); a command or the screen tools can try]');
    expect((await open({ ok: false, code: 'NOT_FOUND', names: [] })).text).toBe('[failed · NOT_FOUND · hint: no Start menu app by that name; a command or the screen tools can try]');
    expect((await open({ ok: false, code: 'NOT_APP' })).text).toBe('[refused · NOT_APP · hint: that is an installer; it goes through run, which asks the user first]');
    const none = desk();
    expect(outcome(await none.t.open({ app: '  ' }))).toBe('failed');
    expect(none.call).not.toHaveBeenCalled();
  });
});

describe('the bridge process', () => {
  /** A child process made of two streams: `lines` is what the bridge wrote to it, say() what it answers. */
  function child(pid: number) {
    const stdin = new PassThrough(), stdout = new PassThrough(), lines: string[] = [];
    stdin.on('data', d => lines.push(...String(d).trim().split('\n')));
    return Object.assign(new EventEmitter(), { pid, stdin, stdout, lines, say: (o: object) => { stdout.write(JSON.stringify(o) + '\n'); } });
  }
  function bridge() {
    const kids: ReturnType<typeof child>[] = [], kill = vi.fn(), spawned: unknown[][] = [];
    const b = new Bridge({ script: 'C:\\app\\dist\\desk-bridge.ps1', kill, spawn: (...a) => { spawned.push(a); const c = child(500 + kids.length); kids.push(c); return c; } });
    return { b, kids, kill, spawned };
  }
  const tick = () => vi.advanceTimersByTimeAsync(0);     // lets the streams deliver
  const why = (p: Promise<unknown>) => p.then(() => 'resolved', e => (e as Error).message);
  afterEach(() => { vi.useRealTimers(); });

  it('starts Windows PowerShell on the script, hidden, and waits for its ready line', async () => {
    vi.useFakeTimers();
    const { b, kids, spawned } = bridge();
    const p = b.call({ cmd: 'windows' });
    await tick();
    expect(spawned).toHaveLength(1);
    expect(String(spawned[0][0])).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    expect(spawned[0][1]).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\app\\dist\\desk-bridge.ps1']);
    expect(spawned[0][2]).toMatchObject({ windowsHide: true });
    expect(kids[0].lines).toEqual([]);                   // nothing is sent before it is ready
    kids[0].say({ ready: true });
    await tick();
    expect(kids[0].lines).toEqual(['{"cmd":"windows"}']);
    kids[0].say({ ok: true, windows: [] });
    expect(await p).toEqual({ ok: true, windows: [] });
  });

  it('answers queued calls in order, on one process', async () => {
    vi.useFakeTimers();
    const { b, kids } = bridge();
    const first = b.call({ cmd: 'windows' }), second = b.call({ cmd: 'read', hwnd: 7 });
    await tick();
    kids[0].say({ ready: true });
    await tick();
    expect(kids[0].lines).toEqual(['{"cmd":"windows"}']); // one at a time
    kids[0].say({ ok: true, n: 1 });
    await tick();
    expect(kids[0].lines).toEqual(['{"cmd":"windows"}', '{"cmd":"read","hwnd":7}']);
    kids[0].say({ ok: false, code: 'STALE' });
    expect(await first).toEqual({ ok: true, n: 1 });
    expect(await second).toEqual({ ok: false, code: 'STALE' });   // a command that ran and failed resolves
    expect(kids).toHaveLength(1);
  });

  it('rejects on an {error} reply', async () => {
    vi.useFakeTimers();
    const { b, kids } = bridge();
    const p = why(b.call({ cmd: 'nope' }));
    await tick();
    kids[0].say({ ready: true });
    await tick();
    kids[0].say({ error: 'unknown command: nope' });
    expect(await p).toBe('unknown command: nope');
  });

  it('kills a process that does not answer in 15 s (20 s for open), and starts a new one for the next call', async () => {
    vi.useFakeTimers();
    const { b, kids, kill } = bridge();
    const t = deskTools({ bridge: b, ask: async () => true, own: () => new Set([OWN]), log: () => {} });
    const r = t.read({});
    await tick();
    kids[0].say({ ready: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await r).text).toBe('[failed · BRIDGE · no answer in 15 s · hint: use the screen tools]');
    expect(kill).toHaveBeenCalledWith(500);
    kids[0].say({ ok: true, windows: [] });              // too late: it answers nobody
    const next = why(b.call({ cmd: 'open', name: 'x' }));
    await tick();
    expect(kids).toHaveLength(2);
    kids[1].say({ ready: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(kill).toHaveBeenCalledTimes(1);               // open has 20 s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await next).toBe('no answer in 20 s');
    expect(kill).toHaveBeenLastCalledWith(501);
  });

  it('fails the call when the process ends under it', async () => {
    vi.useFakeTimers();
    const { b, kids, kill } = bridge();
    const p = why(b.call({ cmd: 'windows' }));
    await tick();
    kids[0].say({ ready: true });
    await tick();
    kids[0].emit('exit', 1);
    expect(await p).toBe('the background helper stopped');
    expect(kill).not.toHaveBeenCalled();
    const again = b.call({ cmd: 'windows' });
    await tick();
    kids[1].say({ ready: true });
    await tick();
    kids[1].say({ ok: true });
    expect(await again).toEqual({ ok: true });
  });

  it('stays down after two starts that failed in a row', async () => {
    vi.useFakeTimers();
    const { b, kids } = bridge();
    const first = why(b.call({ cmd: 'windows' }));
    await tick();
    kids[0].say({ error: 'Add-Type failed' });
    expect(await first).toBe('it did not start (Add-Type failed)');
    const second = why(b.call({ cmd: 'windows' }));
    await tick();
    await vi.advanceTimersByTimeAsync(15_000);           // this one never says ready
    expect(await second).toBe(DOWN);
    expect(await why(b.call({ cmd: 'windows' }))).toBe(DOWN);
    const t = deskTools({ bridge: b, ask: async () => true, own: () => new Set([OWN]), log: () => {} });
    const line = "[failed · BRIDGE · hint: background control isn't available on this PC; use the screen tools]";
    expect((await t.read({})).text).toBe(line);
    expect((await t.open({ app: 'Calculator' })).text).toBe(line);
    expect(kids).toHaveLength(2);                        // no third start
  });

  it('stop() kills it', async () => {
    vi.useFakeTimers();
    const { b, kids, kill } = bridge();
    const p = b.call({ cmd: 'windows' });
    await tick();
    kids[0].say({ ready: true });
    await tick();
    kids[0].say({ ok: true });
    await p;
    b.stop();
    expect(kill).toHaveBeenCalledWith(500);
    b.stop();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('the desk server', () => {
  it('passes a call on to Blob and gives back its text as it is', async () => {
    const seen: any[] = [];
    const fake = (async (url: string, init: any) => { seen.push({ url, token: init.headers['x-desk-token'], body: JSON.parse(init.body) }); return new Response(JSON.stringify({ text: 'Pressed "One".\n[confirmed]', isError: false })); }) as unknown as typeof fetch;
    expect(await forward('act', { steps: [] }, { url: 'http://127.0.0.1:1/desk', token: 't', fetch: fake })).toEqual({ text: 'Pressed "One".\n[confirmed]', isError: false });
    expect(seen).toEqual([{ url: 'http://127.0.0.1:1/desk', token: 't', body: { tool: 'act', args: { steps: [] } } }]);
  });

  it('says so when Blob did not start it or cannot be reached', async () => {
    const line = "[failed · BRIDGE · hint: Blob didn't start this server; use the screen tools]";
    expect(await forward('read', {}, { url: '', token: '' })).toEqual({ text: line, isError: true });
    expect((await forward('read', {}, { url: 'http://x/desk', token: 't', fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch })).text).toBe(line);
    expect((await forward('read', {}, { url: 'http://x/desk', token: 't', fetch: (async () => { throw new Error('refused'); }) as unknown as typeof fetch })).text).toBe(line);
  });

  it('does not say "failed" when Blob only took too long: the steps may still be running', async () => {
    const slow = (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    const r = await forward('act', { steps: [] }, { url: 'http://x/desk', token: 't', fetch: slow });
    expect(outcomeOf(r.text, r.isError).outcome).toBe('unverified');
  });
});

describe('never', () => {
  it('no file of the desk names a call that takes the focus, the front, the keyboard or the pointer', () => {
    const banned = [
      'SetFocus', 'SetForegroundWindow', 'BringWindowToTop', 'SetActiveWindow', 'AttachThreadInput', 'ShowWindow', 'SetWindowPos',
      'SendInput', 'SendKeys', 'keybd_event', 'mouse_event', 'SetCursorPos',
      'PostMessage', 'SendMessage', 'WM_CHAR', 'WM_KEY', 'BM_CLICK',
      'SetWindowVisualState', 'ScrollIntoView',
    ];
    for (const file of ['src/desk-bridge.ps1', 'src/desk.ts', 'src/desk-mcp.ts']) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const name of banned) expect(text.includes(name), `${file}: ${name}`).toBe(false);
    }
  });

  it('a Store app is worked only while it is in front: working one behind brings it forward', () => {
    const text = readFileSync(new URL('../src/desk-bridge.ps1', import.meta.url), 'utf8');
    expect(text).toMatch(/ClassOf\(\$h\) -eq 'ApplicationFrameWindow' -and \$front -ne \$h -and -not \(\$hosted -and \[Win\]::PidOf\(\$front\) -eq \$hosted\)\) \{ return @\{ ok = \$false; code = 'NOT_IN_BACKGROUND' \} \}/);
    // before anything is pressed: the check comes ahead of Do-Action
    expect(text.indexOf("'ApplicationFrameWindow' -and $front")).toBeLessThan(text.indexOf('$r = Do-Action'));
  });

  it('the bridge script is plain ASCII: Windows PowerShell reads a file with no BOM in the system code page', () => {
    expect(readFileSync(new URL('../src/desk-bridge.ps1', import.meta.url), 'utf8')).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });

  it('an AI assistant\'s window, by the same list as clawdcursor 2.0.0', () => {
    expect(AI_HOSTS).toEqual(['claude', 'claude-desktop', 'chatgpt', 'codex', 'cursor', 'code', 'code-insiders', 'code - insiders', 'windsurf', 'zed', 'zeditor', 'zed-editor']);
    for (const app of ['Claude.exe', 'C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\Cursor.exe', 'Code - Insiders', 'codex', 'ChatGPT.app']) expect(isAiHost(app), app).toBe(true);
    for (const app of ['Notepad', 'codexplorer', 'msedge', '']) expect(isAiHost(app), app).toBe(false);
  });

  it('Blob\'s own processes: this one, and the web view\'s from the file, read each time', () => {
    expect(ownPids(undefined)).toEqual(new Set([process.pid]));
    expect(ownPids('f', () => '200,201,x,,-3')).toEqual(new Set([process.pid, 200, 201]));
    expect(ownPids('f', () => { throw new Error('ENOENT'); })).toEqual(new Set([process.pid]));
  });
});
