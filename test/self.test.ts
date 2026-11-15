// Settings, the self tools (with a fake question and a fake host) and the self-description. Temp folder only.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outcomeOf } from '../src/brain.ts';
import { persona } from '../src/persona.ts';
import { question, selfTools, type HostAction } from '../src/self-mcp.ts';
import { DEFAULTS, SettingsStore, loadSettings, parseValue } from '../src/settings.ts';

let dir = '';
let file = '';
let asked: string[] = [];
let answer = false;
let hosted: [HostAction, unknown][] = [];
const outcome = (r: { text: string; isError: boolean }) => outcomeOf(r.text, r.isError).outcome;
const tools = (store = new SettingsStore(file)) => selfTools({
  settings: store,
  ask: async q => { asked.push(q); return answer; },
  host: async (action, body) => { hosted.push([action, body]); return { ok: true, text: `did ${action}` }; },
  activityFile: join(dir, 'activity.jsonl'),
  habitsFile: join(dir, 'habits.json'),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blob-self-'));
  file = join(dir, 'settings.json');
  asked = []; hosted = []; answer = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('settings', () => {
  it('starts with the defaults: nothing that learns is on, not onboarded', () => {
    expect(loadSettings(file)).toEqual(DEFAULTS);
    expect(DEFAULTS).toEqual({ model: 'sonnet', watching: false, autoShortcuts: true, voice: true, phonePaired: false, onboarded: false });
  });

  it('tolerates junk: a broken file, wrong types and unknown keys fall back to the defaults', () => {
    writeFileSync(file, '{ not json');
    expect(loadSettings(file)).toEqual(DEFAULTS);
    writeFileSync(file, JSON.stringify({ model: 'gpt', watching: 'yes', voice: false, extra: 1, onboarded: null }));
    expect(loadSettings(file)).toEqual({ ...DEFAULTS, voice: false });
    writeFileSync(file, '[1,2]');
    expect(loadSettings(file)).toEqual(DEFAULTS);
  });

  it('saves a change and tells listeners which key changed, once', () => {
    const store = new SettingsStore(file);
    const heard: string[][] = [];
    store.onChange((_now, keys) => heard.push(keys));
    store.set('model', 'haiku');
    store.set('model', 'haiku');
    expect(heard).toEqual([['model']]);
    expect(loadSettings(file).model).toBe('haiku');
  });

  it('hears a change another process wrote, and keeps it when setting another key', () => {
    const host = new SettingsStore(file), other = new SettingsStore(file);
    const heard: string[][] = [];
    host.onChange((_now, keys) => heard.push(keys));
    other.set('watching', true);
    host.reload();
    expect(heard).toEqual([['watching']]);
    host.set('onboarded', true);
    expect(loadSettings(file)).toMatchObject({ watching: true, onboarded: true });
  });

  it('reads values as the model may send them', () => {
    expect(parseValue('model', ' Haiku ')).toBe('haiku');
    expect(parseValue('model', 'gpt')).toBeUndefined();
    expect(parseValue('watching', 'off')).toBe(false);
    expect(parseValue('watching', 'maybe')).toBeUndefined();
  });
});

describe('change_setting', () => {
  it('asks first and applies on Yes; a model change says it starts with the next request', async () => {
    answer = true;
    const r = await tools().change_setting({ key: 'model', value: 'haiku' });
    expect(asked).toEqual(['Switch to Haiku?']);
    expect(outcome(r)).toBe('confirmed');
    expect(r.text).toMatch(/next request/);
    expect(loadSettings(file).model).toBe('haiku');
  });

  it('changes nothing on No', async () => {
    const r = await tools().change_setting({ key: 'watching', value: true });
    expect(asked).toHaveLength(1);
    expect(outcome(r)).toBe('refused');
    expect(r.text).toMatch(/USER_SAID_NO/);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses unknown keys, read-only keys and bad values without asking', async () => {
    answer = true;
    expect((await tools().change_setting({ key: 'theme', value: 'dark' })).text).toMatch(/UNKNOWN_KEY/);
    expect((await tools().change_setting({ key: 'toString', value: 'x' })).text).toMatch(/UNKNOWN_KEY/);
    expect((await tools().change_setting({ key: 'phonePaired', value: true })).text).toMatch(/READ_ONLY/);
    expect((await tools().change_setting({ key: 'onboarded', value: true })).text).toMatch(/READ_ONLY/);
    expect((await tools().change_setting({ key: 'model', value: 'gpt' })).text).toMatch(/BAD_VALUE/);
    expect(asked).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('does not ask for what is already so', async () => {
    expect(outcome(await tools().change_setting({ key: 'voice', value: 'on' }))).toBe('confirmed');
    expect(asked).toEqual([]);
  });

  it('writes the card itself: one plain question per change', () => {
    expect(question('model', 'default')).toMatch(/default model\?$/);
    expect(question('watching', true)).toMatch(/No screenshots/);
    expect(question('watching', false)).toBe('Stop watching?');
    expect(question('autoShortcuts', false)).toMatch(/^Stop making shortcuts/);
  });
});

describe('the other self tools', () => {
  it('about and get_settings show the settings as they are', () => {
    new SettingsStore(file).set('watching', true);
    expect(tools().about().text).toMatch(/watching = true/);
    expect(JSON.parse(tools().get_settings().text)).toEqual({ ...DEFAULTS, watching: true });
  });

  it('forget_watching asks, and deletes only on Yes', async () => {
    const activity = join(dir, 'activity.jsonl');
    writeFileSync(activity, JSON.stringify({ t: Date.now(), app: 'Notepad', title: 'a' }) + '\n');
    expect(outcome(await tools().forget_watching())).toBe('refused');
    expect(existsSync(activity)).toBe(true);
    expect(tools().habits().text).toMatch(/Notepad \(1×\)/);
    answer = true;
    expect(outcome(await tools().forget_watching())).toBe('confirmed');
    expect(existsSync(activity)).toBe(false);
    expect(tools().habits().text).toMatch(/Apps: nothing noted yet/);
  });

  it('hands shortcuts and pairing to the host; unpair asks first', async () => {
    expect(outcome(await tools().save_last_as_shortcut({ name: ' Inbox ' }))).toBe('confirmed');
    expect(outcome(await tools().pair_phone())).toBe('confirmed');
    expect(hosted).toEqual([['save_shortcut', { name: 'Inbox' }], ['pair', undefined]]);
    expect(asked).toEqual([]);
    expect((await tools().unpair_phone()).text).toMatch(/No phone is paired/);
    new SettingsStore(file).set('phonePaired', true);
    expect(outcome(await tools().unpair_phone())).toBe('refused');
    expect(asked).toEqual(['Unpair your phone?']);
    expect(hosted).toHaveLength(2);
  });
});

describe('persona', () => {
  it('says what Blob is, how it changes settings, and reflects them', () => {
    const off = persona(DEFAULTS);
    expect(off).toMatch(/You are Blob/);
    expect(off).toMatch(/change_setting/);
    expect(off).toMatch(/model Sonnet; watching off; auto-shortcuts on; voice on; phone not paired/);
    expect(off).toMatch(/watching is off/);
    const on = persona({ ...DEFAULTS, model: 'haiku', watching: true, autoShortcuts: false, phonePaired: true });
    expect(on).toMatch(/model Haiku; watching on; auto-shortcuts off; voice on; phone paired/);
    expect(on).toMatch(/no screenshots/);
    expect(on).toMatch(/do not make shortcuts on your own/);
    expect(on.length).toBeLessThan(2000);
  });
});
