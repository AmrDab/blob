// macOS only: what the window library has no option for, done through the Objective-C runtime (koffi).
//  - an Edit menu, so Cmd+C/V/X/A/Z reach the page's text boxes (AppKit sends those keys through the app's menu);
//  - the first click on Blob while another app is in front reaches the page, not just brings Blob forward;
//  - Cmd+Q (and any other "terminate") runs Blob's own quit, so the brain is stopped and the temp folder removed;
//  - opened again while open (Spotlight, Finder), the bubble comes forward and says so;
//  - no Dock icon, no Cmd+Tab entry and no menu bar of its own (an "accessory" app);
//  - the bubble and the pill are on every Space, and over full-screen apps.
// Every step is on its own: one that fails says so in the log and the rest still run. Only macOS has it (os.appSetup).
import { createRequire } from 'node:module';
import type { Application, MenuOptions } from '@webviewjs/webview';

/** The few Objective-C runtime calls used here. Objects, classes and selectors are opaque pointers. */
export interface ObjC {
  /** null when there is no such class. */
  cls(name: string): unknown;
  classOf(obj: unknown): unknown;
  /** The runtime name of a class. */
  name(cls: unknown): string;
  /** A message with no argument that answers an object. */
  send(obj: unknown, sel: string): unknown;
  /** A message with one whole-number argument that answers an object (objectAtIndex:). */
  at(obj: unknown, sel: string, i: number): unknown;
  /** A message with no argument that answers a whole number. */
  num(obj: unknown, sel: string): number;
  /** A message with one whole-number argument, the answer not used. */
  set(obj: unknown, sel: string, value: number): void;
  /** Sends the Apple Event `eventClass`/`eventID` to `target`'s method `sel` (NSAppleEventManager). */
  appleEvent(target: unknown, sel: string, eventClass: number, eventID: number): void;
  /** Puts `fn` in place of a method that takes one object. `types`: its type encoding ('v@:@' answers nothing, else a BOOL). */
  replace(cls: unknown, sel: string, types: string, fn: () => boolean | void): void;
}

const kept: unknown[] = [];      // the callbacks AppKit keeps calling: never unregistered
let loaded: ObjC | undefined;    // made once: koffi refuses a second type with the same name

/** The real runtime, the same one on every call. Throws where it can't be loaded. */
export function loadObjC(): ObjC {
  if (loaded) return loaded;
  const koffi = createRequire(import.meta.url)('koffi');
  const lib = koffi.load('/usr/lib/libobjc.A.dylib');
  const getClass = lib.func('void *objc_getClass(const char *name)');
  const objectGetClass = lib.func('void *object_getClass(void *obj)');
  const className = lib.func('const char *class_getName(void *cls)');
  const selector = lib.func('void *sel_registerName(const char *name)');
  const replaceMethod = lib.func('void *class_replaceMethod(void *cls, void *sel, void *imp, const char *types)');
  // objc_msgSend has no one signature: each shape of call is declared on its own
  const send = lib.func('void *objc_msgSend(void *obj, void *sel)');
  const at = lib.func('void *objc_msgSend(void *obj, void *sel, unsigned long i)');
  const num = lib.func('unsigned long objc_msgSend(void *obj, void *sel)');
  const set = lib.func('void objc_msgSend(void *obj, void *sel, unsigned long value)');
  const handler = lib.func('void objc_msgSend(void *obj, void *sel, void *target, void *handler, uint32_t cls, uint32_t id)');
  const Bool = koffi.pointer(koffi.proto('bool BlobBoolMethod(void *self, void *cmd, void *arg)'));
  const Void = koffi.pointer(koffi.proto('void BlobVoidMethod(void *self, void *cmd, void *arg)'));
  return loaded = {
    cls: name => getClass(name),
    classOf: obj => objectGetClass(obj),
    name: cls => String(className(cls) ?? ''),
    send: (obj, sel) => send(obj, selector(sel)),
    at: (obj, sel, i) => at(obj, selector(sel), i),
    num: (obj, sel) => Number(num(obj, selector(sel))),
    set: (obj, sel, value) => { set(obj, selector(sel), value); },
    appleEvent(target, sel, eventClass, eventID) {
      const manager = send(getClass('NSAppleEventManager'), selector('sharedAppleEventManager'));
      handler(manager, selector('setEventHandler:andSelector:forEventClass:andEventID:'), target, selector(sel), eventClass, eventID);
    },
    replace(cls, sel, types, fn) {
      const imp = koffi.register(fn, types.startsWith('v') ? Void : Bool);
      kept.push(imp);
      replaceMethod(cls, selector(sel), imp, types);
    },
  };
}

/** The app in front, for the keyboard hand-back (focus.ts). */
export interface FrontApp {
  /** The process id of the app in front; 0 when there is none. */
  frontPid(): number;
  /** Brings that app to the front. False: it has quit, or macOS said no. */
  activate(pid: number): boolean;
  /** Is Blob the active app? Blob's own state: true as soon as its click was handled, before the system's "app in front" says so. */
  selfActive(): boolean;
  /** The title of Blob's window that has the keyboard; '' when none has. */
  keyTitle(): string;
}

/** The real one. Throws where the runtime can't be loaded. */
export function loadFrontApp(): FrontApp {
  const objc = loadObjC();
  const lib = createRequire(import.meta.url)('koffi').load('/usr/lib/libobjc.A.dylib');
  const selector = lib.func('void *sel_registerName(const char *name)');
  const pidOf = lib.func('int objc_msgSend(void *obj, void *sel)');                              // pid_t
  const byPid = lib.func('void *objc_msgSend(void *cls, void *sel, int pid)');
  const activate = lib.func('bool objc_msgSend(void *obj, void *sel, unsigned long options)');
  const yes = lib.func('bool objc_msgSend(void *obj, void *sel)');
  const text = lib.func('const char *objc_msgSend(void *obj, void *sel)');
  const push = lib.func('void *objc_autoreleasePoolPush()');
  const pop = lib.func('void objc_autoreleasePoolPop(void *pool)');
  // called from a node timer, outside AppKit's own pool: without one, each call would leak the objects it is handed
  const pooled = <T>(fn: () => T): T => { const p = push(); try { return fn(); } finally { pop(p); } };
  const nsapp = () => objc.send(objc.cls('NSApplication'), 'sharedApplication');
  return {
    frontPid: () => pooled(() => {
      const app = objc.send(objc.send(objc.cls('NSWorkspace'), 'sharedWorkspace'), 'frontmostApplication');
      return app ? pidOf(app, selector('processIdentifier')) : 0;
    }),
    activate: pid => pooled(() => {
      const app = byPid(objc.cls('NSRunningApplication'), selector('runningApplicationWithProcessIdentifier:'), pid);
      return app ? !!activate(app, selector('activateWithOptions:'), 0) : false;
    }),
    selfActive: () => pooled(() => !!yes(nsapp(), selector('isActive'))),
    keyTitle: () => pooled(() => {
      const key = objc.send(nsapp(), 'keyWindow'), title = key ? objc.send(key, 'title') : null;
      return title ? String(text(title, selector('UTF8String')) ?? '') : '';
    }),
  };
}

/**
 * The apps open now, by name: the regular ones (with a Dock icon), and the one in front ('' when that is Blob or
 * nothing). Names only, for the request's <computer_now> (computer.ts). Throws where the runtime can't be loaded.
 */
export function loadRunningApps(self: number = process.pid): () => { apps: string[]; front: string } {
  const objc = loadObjC();
  const koffi = createRequire(import.meta.url)('koffi');
  // NSWorkspace lives in AppKit: loaded by the web view inside Blob, but not in a plain node process, where the
  // class would be nil and every read silently empty.
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  if (!objc.cls('NSWorkspace')) throw new Error('NSWorkspace is not available');
  const lib = koffi.load('/usr/lib/libobjc.A.dylib');
  const selector = lib.func('void *sel_registerName(const char *name)');
  const pidOf = lib.func('int objc_msgSend(void *obj, void *sel)');                              // pid_t
  const text = lib.func('const char *objc_msgSend(void *obj, void *sel)');
  const push = lib.func('void *objc_autoreleasePoolPush()');
  const pop = lib.func('void objc_autoreleasePoolPop(void *pool)');
  // Blob itself is left out (it is a regular app until its launch is done, and in front while the user types to it)
  const name = (app: unknown): string => {
    if (!app || pidOf(app, selector('processIdentifier')) === self) return '';
    const s = objc.send(app, 'localizedName');
    return s ? String(text(s, selector('UTF8String')) ?? '') : '';
  };
  return () => {
    const pool = push();
    try {
      const ws = objc.send(objc.cls('NSWorkspace'), 'sharedWorkspace'), all = objc.send(ws, 'runningApplications');
      const apps: string[] = [];
      for (let i = 0, n = all ? objc.num(all, 'count') : 0; i < n; i++) {
        const app = objc.at(all, 'objectAtIndex:', i);
        if (objc.num(app, 'activationPolicy') === 0) apps.push(name(app));          // NSApplicationActivationPolicyRegular
      }
      return { apps: apps.filter(Boolean), front: name(objc.send(ws, 'frontmostApplication')) };
    } finally { pop(pool); }
  };
}

/** The app menu comes first by itself (the window library adds it, with Quit); Blob adds only Edit. */
export const EDIT_MENU: MenuOptions = {
  items: [{
    label: 'Edit',
    submenu: { items: [{ role: 'undo' }, { role: 'redo' }, { role: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectall' }] },
  }],
};

/** A web view's class. Its runtime name carries the library's module path and version, e.g. "wry::wkwebview::class::wry_web_view::WryWebView0.55.1". */
export const WEB_VIEW_CLASS = /(?:^|::|_)WryWebView[\d.]*$/;

/** The classes of the web views in Blob's windows, found by walking each window's views (a few levels down). */
export function webViewClasses(objc: ObjC): unknown[] {
  const found = new Map<string, unknown>();
  const walk = (view: unknown, depth: number): void => {
    if (!view || depth > 4) return;
    const cls = objc.classOf(view), name = objc.name(cls);
    if (WEB_VIEW_CLASS.test(name)) { found.set(name, cls); return; }
    const subs = objc.send(view, 'subviews');
    if (subs) for (let i = 0, n = objc.num(subs, 'count'); i < n; i++) walk(objc.at(subs, 'objectAtIndex:', i), depth + 1);
  };
  const wins = objc.send(objc.send(objc.cls('NSApplication'), 'sharedApplication'), 'windows');
  if (wins) for (let i = 0, n = objc.num(wins, 'count'); i < n; i++) walk(objc.send(objc.at(wins, 'objectAtIndex:', i), 'contentView'), 0);
  return [...found.values()];
}

/**
 * The web view's class says "no" to a first click on a window that is not in front, so the click only brings Blob
 * forward. Its answer is replaced with "yes", for every web view class found (the bubble and the pill share one).
 * The web views exist only once the window library made them. False: none was found.
 */
export function acceptFirstClick(objc: ObjC, arch: string = process.arch): boolean {
  const classes = webViewClasses(objc);
  for (const cls of classes) objc.replace(cls, 'acceptsFirstMouse:', arch === 'arm64' ? 'B@:@' : 'c@:@', () => true);   // BOOL is a char on Intel
  return classes.length > 0;
}

/**
 * Cmd+Q, Quit and logging out all send the app "terminate:", which ends the process from native code: no app event
 * and no process 'exit', so nothing of Blob's quit would run. It is replaced with Blob's quit, run just after (not
 * from inside the window library's own event pump).
 */
export function quitOnTerminate(objc: ObjC, quit: () => void): void {
  const nsapp = objc.send(objc.cls('NSApplication'), 'sharedApplication');
  objc.replace(objc.classOf(nsapp), 'terminate:', 'v@:@', () => { setImmediate(quit); });
}

/** The "reopen" Apple Event ('aevt' 'rapp'): macOS sends it when an app that is open is opened again. */
export const REOPEN = { eventClass: 0x61657674, eventID: 0x72617070 };
const REOPEN_SEL = 'blobReopen:withReply:';

/**
 * Opened again while open (Spotlight, Finder, `open`): macOS launches nothing and sends the app the reopen event.
 * Blob takes that event itself, in place of AppKit's own handler (set at launch, so this runs after it), and runs
 * `reopen` just after (not from inside the event pump). Safe to run again.
 */
export function onReopen(objc: ObjC, reopen: () => void): void {
  const nsapp = objc.send(objc.cls('NSApplication'), 'sharedApplication');
  objc.replace(objc.classOf(nsapp), REOPEN_SEL, 'v@:@@', () => { setImmediate(reopen); });
  objc.appleEvent(nsapp, REOPEN_SEL, REOPEN.eventClass, REOPEN.eventID);
}

const ACCESSORY = 1;                                                    // NSApplicationActivationPolicyAccessory
const ALL_SPACES = 1 << 0, MOVE_TO_ACTIVE = 1 << 1;                     // NSWindowCollectionBehavior: these two can't be set together
const FULL_PRIMARY = 1 << 7, FULL_AUXILIARY = 1 << 8, FULL_NONE = 1 << 9;   // nor can these three

/** The collection behaviour of a window that is on every Space and may sit over a full-screen app. */
export function everywhere(behavior: number): number {
  return (behavior & ~(MOVE_TO_ACTIVE | FULL_PRIMARY | FULL_NONE)) | ALL_SPACES | FULL_AUXILIARY;
}

/**
 * Once the app has launched (the window library sets "regular app" at launch, over anything set before): no Dock icon,
 * Cmd+Tab entry or menu bar, and every window on every Space and over full-screen apps. Safe to run again.
 * The windows come first: one that can be hidden may go away with the Dock icon (or on Cmd+H), with no way back.
 */
export function afterLaunch(objc: ObjC): void {
  const nsapp = objc.send(objc.cls('NSApplication'), 'sharedApplication');
  const wins = objc.send(nsapp, 'windows');
  for (let i = 0, n = objc.num(wins, 'count'); i < n; i++) {
    const w = objc.at(wins, 'objectAtIndex:', i);
    objc.set(w, 'setCanHide:', 0);
    const now = objc.num(w, 'collectionBehavior'), next = everywhere(now);
    if (next !== now) objc.set(w, 'setCollectionBehavior:', next);
  }
  if (objc.num(nsapp, 'activationPolicy') !== ACCESSORY) objc.set(nsapp, 'setActivationPolicy:', ACCESSORY);
}

// The launch happens in the window library's first event pump, some time after app.run(): looked at a few times.
const LAUNCH_MS = [300, 1500, 4000];

export interface MacDeps {
  arch?: string;
  load?: () => ObjC;
  later?: (fn: () => void, ms: number) => unknown;
  /** Blob was opened again while open. */
  reopen?: () => void;
  /** Where SIGUSR2 comes in (tests pass a fake). */
  signals?: { on(signal: 'SIGUSR2', fn: () => void): unknown };
}

/** Everything above, in order. Call once, after the first web view is made. */
export function macSetup(app: Pick<Application, 'setMenu'>, quit: () => void, deps: MacDeps = {}): void {
  const step = (failed: string, fn: () => void): void => {
    try { fn(); } catch (e) { console.log(`Blob: ${failed} (${(e as Error).message})`); }
  };
  step('copy and paste keys do not work in the text boxes', () => app.setMenu(EDIT_MENU));
  let objc: ObjC | undefined;
  step('running as a plain macOS app, with a Dock icon', () => { objc = (deps.load ?? loadObjC)(); });
  if (!objc) return;
  const oc = objc;
  // The web view itself (and so its class) is made in the window library's first event pump, not by createWebview:
  // looked for now and at each launch look, said only when the last one still finds none.
  let firstClick = false;
  const tryFirstClick = (last: boolean) => {
    if (!firstClick) step('the first click on Blob only brings it forward', () => {
      firstClick = acceptFirstClick(oc, deps.arch);
      if (!firstClick && last) throw new Error('no web view class');
    });
  };
  tryFirstClick(false);
  step('Cmd+Q closes Blob without its clean-up', () => quitOnTerminate(oc, quit));
  const later = deps.later ?? setTimeout;
  // Blob.app's own program (blob-launch) is the app macOS opens again: it passes that on to Blob as SIGUSR2.
  if (deps.reopen) step('opening Blob again does not bring it forward', () => {
    (deps.signals ?? process).on('SIGUSR2', () => { setImmediate(deps.reopen!); });
  });
  LAUNCH_MS.forEach((ms, i) => later(() => {
    tryFirstClick(i === LAUNCH_MS.length - 1);
    if (deps.reopen) step('opening Blob again does not bring it forward', () => onReopen(oc, deps.reopen!));
    step('Blob keeps its Dock icon and stays on one Space', () => afterLaunch(oc));
  }, ms));
}
