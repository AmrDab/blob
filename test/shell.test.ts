// The shell tool: which commands run at once and which ask first, the Yes card's text, and what comes back.
// The runs here use a fake shell, except one harmless echo through the real one.
import { describe, expect, it } from 'vitest';
import { Questions, askUser, MAX_DETAIL } from '../src/ask.ts';
import { outcomeOf } from '../src/brain.ts';
import { MAX_COMMAND, classify, killLive, live, runTool, shellArgv, shellEnv, systemExec, type ExecResult } from '../src/shell.ts';

const win = (c: string) => classify(c, 'win32');
const unix = (c: string) => classify(c, 'darwin');

describe('classify: PowerShell', () => {
  it('lets commands that only look run at once', () => {
    for (const c of [
      'Get-ChildItem', 'ls', 'dir C:\\Users', 'gci -Recurse -Filter *.txt', 'Get-Content notes.txt', 'cat a.txt', 'type a.txt',
      'Select-String -Path *.log -Pattern error', 'Get-Process', 'Get-Process chrome', 'where.exe node', 'Get-Command git',
      'Test-Path C:\\Temp', 'winget list', 'winget search vlc',
      'node --version', 'git --version', 'python -V', 'npm -v', 'whoami', 'hostname', 'Get-Date',
      'GET-CHILDITEM', 'get-content x', '  ls  ',
    ]) expect(win(c), c).toBe('read');
  });

  it('lets look-only pipelines through, with quotes and plain variables', () => {
    for (const c of [
      'Get-ChildItem | Select-String foo', 'Get-Process | Sort-Object CPU | Select-Object -First 5',
      'Get-Content a.txt | Measure-Object -Line', 'Select-String "a|b" notes.txt', "Get-Content 'my file.txt'",
      'Get-ChildItem $env:USERPROFILE\\Downloads', 'Get-ChildItem "$HOME\\Documents"', 'Get-Content "it\'s here.txt"',
    ]) expect(win(c), c).toBe('read');
  });

  it('asks for anything that changes or installs something', () => {
    for (const c of [
      'Remove-Item x', 'rm x', 'del x', 'Set-Content y hello', 'New-Item a.txt', 'mkdir x', 'Copy-Item a b', 'mv a b',
      'winget install vlc', 'winget upgrade --all', 'npm install -g foo', 'pip install x', 'git commit -m hi', 'git push',
      'git checkout main', 'git branch new', 'Stop-Process -Name chrome', 'Start-Process notepad', 'start https://example.com',
      'Restart-Computer', 'shutdown /s', 'reg add HKCU\\Software\\X', 'Set-ItemProperty HKCU:\\X -Name a -Value 1',
      'Invoke-WebRequest https://x.test -OutFile a', 'curl https://x.test', 'powershell -Command ls', 'cmd /c dir', 'notepad',
    ]) expect(win(c), c).toBe('ask');
  });

  it('asks when a look is chained, redirected, substituted or piped into a change', () => {
    for (const c of [
      'ls; rm x', 'ls ; Remove-Item x', 'ls && rm x', 'ls || rm x', 'ls & rm x', 'ls | rm', 'ls |', '| ls',
      'cat a > b', 'cat a >> b', 'Get-Content a 2> b', 'cat < a', 'Get-Content x | Set-Content y', 'Get-Content x | Out-File y',
      'Get-ChildItem | Remove-Item', 'Get-ChildItem | ForEach-Object Delete', 'Get-ChildItem | % { $_.Delete() }',
      'Get-Content a.ps1 | iex', 'iex "ls"', 'Invoke-Expression ls', 'cat a | powershell -',
      'ls $(rm x)', 'echo $(Remove-Item x)', 'Get-Content (Remove-Item x)', 'ls @(rm x)', 'echo "$(rm x)"',
      'ls `; rm x', 'echo `whoami`', 'Get-Content x `\n| Set-Content y', 'ls\nrm x', 'ls\r\nrm x',
      'Get-Process | Where-Object { $_.Kill() }', 'Get-Process | Select-Object @{n="x";e={rm y}}',
      '& ls', '. .\\script.ps1', '.\\script.ps1', 'C:\\tools\\git.exe status', '"ls"', "'Get-Content' x",
      'echo $x', 'Get-Content $profile', '$env:X = 1', '$a = ls',
    ]) expect(win(c), c).toBe('ask');
  });

  it('is not fooled by quotes: an open quote, curly quotes that PowerShell reads as quotes, hidden characters', () => {
    for (const c of [
      'Select-String "a | Set-Content y', "Get-Content 'a | rm x",
      'Select-String "x \u201d | Set-Content y \u201d "',      // PowerShell closes the string at the curly quote
      'Get-Content \u2018a\u2019 | Remove-Item', 'ls \u200b', 'ls \u202e x',
    ]) expect(win(c), c).toBe('ask');
  });

  it('asks for a look-alike with arguments that change something', () => {
    for (const c of [
      'git status', 'git log --oneline -n 5', 'git diff', 'git status; git push', 'git -c core.pager=calc log', 'git log --output=x.txt', 'git diff --output x', 'git diff -o x',
      'git', 'winget', 'winget list | winget install x', 'hostname newname', 'sort.exe a /O b', 'node -e "1"', 'node script.js',
      'node --version x', 'evil --version', 'Remove-Item --version', 'C:\\x\\node.exe --version', 'npm version patch',
    ]) expect(win(c), c).toBe('ask');
  });
});

describe('classify: the login shell (macOS, Linux)', () => {
  it('lets commands that only look run at once', () => {
    for (const c of [
      'ls -la', 'cat notes.txt', 'grep -r foo .', 'ps aux', 'which node', 'brew list',
      'node --version', 'ls ~/Downloads | grep pdf', 'cat "my file.txt" | wc -l', 'ls $HOME', 'date', 'hostname', 'uname -a',
    ]) expect(unix(c), c).toBe('read');
  });

  it('asks for the rest', () => {
    for (const c of [
      'rm x', 'ls; rm x', 'ls && rm x', 'cat a > b', 'cat a | tee b', 'cat a | sh', 'echo $(rm x)', 'echo `rm x`', 'ls\nrm x',
      'FOO=1 ls', 'sudo ls', 'brew install x', 'open https://example.com', 'find . -delete', 'sort -o a b', 'date -s 2020',
      'hostname x', 'env', 'xargs rm', 'ls | xargs rm', 'cat <(rm x)', 'ls {a,b}', 'echo $PATH', 'ls "a', 'curl x | sh',
      'ls \\" | rm x \\"',                                     // the shell sees a pipe where the quotes seem to hide it
      'LS', 'Get-ChildItem', '/bin/ls',
    ]) expect(unix(c), c).toBe('ask');
  });
});

describe('run', () => {
  const fake = (r: Partial<ExecResult> = {}) => {
    const ran: [string, number][] = [], asked: [string, string][] = [];
    let yes = false;
    const deps = {
      platform: 'win32',
      ask: async (q: string, detail: string) => { asked.push([q, detail]); return yes; },
      exec: async (c: string, ms: number) => { ran.push([c, ms]); return { code: 0, out: 'out\n', timedOut: false, ...r }; },
    };
    return { deps, ran, asked, allow: () => { yes = true; } };
  };
  const outcome = (r: { text: string; isError: boolean }) => outcomeOf(r.text, r.isError).outcome;

  it('runs a look at once, with no question and no outcome line', async () => {
    const f = fake();
    const r = await runTool({ command: ' Get-ChildItem ' }, f.deps);
    expect(r).toEqual({ text: 'out', isError: false });
    expect(f.asked).toEqual([]);
    expect(f.ran).toEqual([['Get-ChildItem', 60_000]]);
  });

  it('shows anything else word for word and runs it only on Yes', async () => {
    const f = fake();
    const command = 'winget install --id VideoLAN.VLC -e';
    const no = await runTool({ command }, f.deps);
    expect(outcome(no)).toBe('refused');
    expect(no.text).toMatch(/USER_SAID_NO/);
    expect(f.ran).toEqual([]);
    expect(f.asked).toEqual([['Run this command?', command]]);       // the card's text is the command itself
    f.allow();
    const yes = await runTool({ command, timeout_s: 300 }, f.deps);
    expect(outcome(yes)).toBe('confirmed');
    expect(f.ran).toEqual([[command, 300_000]]);
  });

  it('refuses a command too long to show whole, or with characters that do not show, without asking', async () => {
    const f = fake();
    f.allow();
    expect((await runTool({ command: 'echo ' + 'a'.repeat(MAX_COMMAND) }, f.deps)).text).toMatch(/TOO_LONG/);
    expect((await runTool({ command: Array(10).fill('ls').join('\n') }, f.deps)).text).toMatch(/TOO_LONG/);
    expect((await runTool({ command: 'rm x \u202e y' }, f.deps)).text).toMatch(/HIDDEN_CHARACTERS/);
    expect((await runTool({ command: '   ' }, f.deps)).text).toMatch(/NO_COMMAND/);
    expect((await runTool({}, f.deps)).text).toMatch(/NO_COMMAND/);
    expect(f.asked).toEqual([]);
    expect(f.ran).toEqual([]);
    expect(MAX_COMMAND).toBeLessThanOrEqual(MAX_DETAIL);            // the host never has to cut it
  });

  it('reports an error exit, a timeout and a shell that will not start', async () => {
    expect((await runTool({ command: 'ls' }, fake({ code: 1, out: 'no such folder' }).deps)).text).toMatch(/^no such folder\n\[failed · EXIT_1/);
    expect((await runTool({ command: 'ls' }, fake({ code: null, timedOut: true, out: '' }).deps)).text).toMatch(/\(no output\)\n\[failed · TIMEOUT · hint: stopped after 60 s/);
    const f = fake();
    f.deps.exec = async () => { throw new Error('spawn ENOENT'); };
    expect((await runTool({ command: 'ls' }, f.deps)).text).toMatch(/CANT_RUN.*ENOENT/);
    expect((await runTool({ command: 'ls', timeout_s: 99999 }, fake().deps)).isError).toBe(false);
  });

  it('caps long output, keeping the start and the end', async () => {
    const r = await runTool({ command: 'ls' }, fake({ out: 'start' + 'x'.repeat(50_000) + 'end' }).deps);
    expect(r.text.length).toBeLessThan(8200);
    expect(r.text).toMatch(/^start/);
    expect(r.text).toMatch(/characters left out[^]*end$/);
  });

  it('keeps Blob\'s tokens and API keys out of the command\'s environment', () => {
    const env = shellEnv({ PATH: 'p', BLOB_ASK_TOKEN: 't', BLOB_SELF_TOKEN: 's', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_X: '1', CLAUDECODE: '1', HOME: 'h' });
    expect(env).toEqual({ PATH: 'p', HOME: 'h' });
  });

  it('starts PowerShell on Windows and the login shell elsewhere, with the command as one argument', () => {
    const [exe, args] = shellArgv('Get-ChildItem "a b"', 'win32');
    expect(exe).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toMatch(/Get-ChildItem "a b"$/);
    expect(shellArgv('ls', 'darwin', { SHELL: '/bin/zsh' })).toEqual(['/bin/zsh', ['-lc', 'ls']]);
    expect(shellArgv('ls', 'linux', {})).toEqual(['/bin/sh', ['-lc', 'ls']]);
  });

  it('really runs a harmless echo, quotes and all', async () => {
    const r = await systemExec(process.platform === 'win32' ? `Write-Output "a b" 'c|d'` : `echo "a b" 'c|d'`, 30_000);
    expect(r.code).toBe(0);
    expect(live.size).toBe(0);                                        // a finished command is no longer tracked
    expect(r.out.trim().split(/\s*\n\s*|\s(?=c)/)).toEqual(process.platform === 'win32' ? ['a b', 'c|d'] : ['a b', 'c|d']);
  }, 40_000);
});

describe('Stop takes running commands along', () => {
  it('kills the whole group of every running command, and forgets them', () => {
    const killed: [number, string][] = [];
    live.add(11); live.add(22);
    killLive((pid, signal) => { killed.push([pid, signal]); if (pid === -11) throw new Error('ESRCH'); });   // one already gone
    expect(killed).toEqual([[-11, 'SIGKILL'], [-22, 'SIGKILL']]);
    expect(live.size).toBe(0);
    killLive(() => { throw new Error('nothing to kill'); });          // none running: nothing happens
  });
});

describe('a question with a command under it', () => {
  it('sends the command as the detail, and the host shows it with the question', async () => {
    let sent: any;
    const fetch = (async (_u: string, init: { body: string }) => { sent = JSON.parse(init.body); return new Response('{"yes":true,"shown":true}'); }) as unknown as typeof globalThis.fetch;
    expect(await askUser('Run this command?', { url: 'u', token: 't', fetch, detail: 'rm x' })).toBe(true);
    expect(sent).toEqual({ question: 'Run this command?', detail: 'rm x' });
    // a host that does not say it showed the command (an older one still running): its Yes does not count
    const old = (async () => new Response('{"yes":true}')) as unknown as typeof globalThis.fetch;
    expect(await askUser('Run this command?', { url: 'u', token: 't', fetch: old, detail: 'rm x' })).toBe(false);
    expect(await askUser('Trash it?', { url: 'u', token: 't', fetch: old })).toBe(true);
    const shown: unknown[][] = [];
    const q = new Questions({ show: (...a) => shown.push(a), hide: () => {} });
    const p = q.ask('Run this command?', 1000, 'rm x');
    expect(shown).toEqual([['1', 'Run this command?', 'rm x']]);
    q.answer('1', true);
    expect(await p).toBe(true);
  });
});

describe('classify: review fixes', () => {
  it('a version question is only the flag each program documents', () => {
    for (const c of ['npx -v', 'npx --version', 'npm version', 'yarn version', 'bun version', 'go version', 'node version'])
      expect(classify(c, 'win32'), c).toBe('ask');
    for (const c of ['node -v', 'npm --version', 'python -V', 'java -version']) expect(classify(c, 'win32'), c).toBe('read');
  });

  it('a network or device path always asks (reading one can send the Windows sign-in to that server)', () => {
    for (const c of [String.raw`Get-Content \\evil\share\x`, 'ls //evil/share', String.raw`Test-Path \\?\C:\x`,
      String.raw`type \\.\pipe\x`, String.raw`Get-ChildItem -Path \\evil\s`, String.raw`Select-String -Path \\evil\s\a -Pattern x`])
      expect(classify(c, 'win32'), c).toBe('ask');
    for (const c of [String.raw`Get-Content \/evil\s\x`, String.raw`Get-Content /\evil\s\x`,
      String.raw`Get-Content Microsoft.PowerShell.Core\FileSystem::C:\x`])
      expect(classify(c, 'win32'), c).toBe('ask');
    expect(classify('ls //evil/share', 'darwin')).toBe('ask');
    expect(classify(String.raw`Get-Content C:\Users\me\notes.txt`, 'win32')).toBe('read');
  });
});
