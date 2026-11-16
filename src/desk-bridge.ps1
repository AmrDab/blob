# Parts copied from clawdcursor scripts/ps-bridge.ps1 @ ebedea01 (MIT, Amr Dabbas): UiaProxies, UiaInvoker, Get-ShownValue, Get-HostedApp, the ConvertTo-UINode walk rules, the ListWindows skip rules.
# Blob's desk bridge: one long-lived Windows PowerShell 5.1 process that works open windows through UI Automation,
# with no pointer, no keyboard and no window raised. One JSON line in, one JSON line out; Blob's main process starts
# it once and keeps it (src/desk.ts). The five commands and their replies are the contract a Mac bridge would keep.

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

# -InputObject, never a pipe: a piped empty array writes nothing, and the caller would wait for its line.
function Say($r) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $r -Depth 20 -Compress))
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase @'
using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

// The managed UIA proxies for Win32 controls, registered from compiled code: from script the stack walk that
// loads them throws, and every Win32 Edit or Button then shows as a plain Pane with nothing to press or set.
public static class UiaProxies {
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void Register() {
        var n = typeof(AutomationElement).Assembly.GetName();
        n.Name = "UIAutomationClientsideProviders";
        ClientSettings.RegisterClientSideProviderAssembly(n);
    }
}

// Invoke on a Win32 button returns only when the box it opened is closed (so do a toggle, a select and a set that
// open one). It runs on a worker; after waitMs the answer is "pending" and the bridge serves the next command. A failure after that is kept for TakeLateError.
public static class UiaInvoker {
    static readonly object Gate = new object();
    static string _late;
    class Call { public bool Done, Abandoned; public string Error; }
    // "ok", "error:<message>" or "pending".
    public static string Run(Action action, int waitMs) {
        var call = new Call();
        var t = new System.Threading.Thread(() => {
            string err = null;
            try { action(); } catch (Exception e) { err = (e.InnerException ?? e).Message; }
            lock (Gate) { call.Done = true; call.Error = err; if (call.Abandoned && err != null) _late = err; }
        });
        t.IsBackground = true;
        t.SetApartmentState(System.Threading.ApartmentState.MTA);
        t.Start();
        t.Join(waitMs);
        lock (Gate) {
            if (call.Done) return call.Error == null ? "ok" : "error:" + call.Error;
            call.Abandoned = true;
            return "pending";
        }
    }
    public static string Invoke(InvokePattern p, int waitMs) { return Run(p.Invoke, waitMs); }
    public static string Expand(ExpandCollapsePattern p, int waitMs) { return Run(p.Expand, waitMs); }
    public static string Collapse(ExpandCollapsePattern p, int waitMs) { return Run(p.Collapse, waitMs); }
    public static string Toggle(TogglePattern p, int waitMs) { return Run(p.Toggle, waitMs); }
    public static string Select(SelectionItemPattern p, int waitMs) { return Run(p.Select, waitMs); }
    public static string SetValue(ValuePattern p, string v, int waitMs) { return Run(() => p.SetValue(v), waitMs); }
    public static string SetNumber(RangeValuePattern p, double v, int waitMs) { return Run(() => p.SetValue(v), waitMs); }
    public static string TakeLateError() { lock (Gate) { var e = _late; _late = null; return e; } }
}

// Win32 that only looks: which windows there are, whose they are, and where the front window and the pointer are.
public static class Win {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int used);

    // Every top-level window, front to back.
    public static long[] All() {
        var l = new List<long>();
        EnumWindows((h, p) => { l.Add(h.ToInt64()); return true; }, IntPtr.Zero);
        return l.ToArray();
    }
    public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
    public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    public static int PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return (int)p; }
    // A Store app's own window inside its frame.
    public static IntPtr CoreOf(IntPtr h) { return FindWindowEx(h, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null); }
    public static string Cursor() { POINT p; GetCursorPos(out p); return p.X + "," + p.Y; }

    // A window the desk lists: top-level, visible, not cloaked, titled, not a tool or no-activate window, not the shell's.
    public static bool Listed(IntPtr h) {
        if (GetAncestor(h, 2) != h || !IsWindowVisible(h)) return false;          // GA_ROOT
        int cloaked = 0;
        DwmGetWindowAttribute(h, 14, out cloaked, 4);                              // DWMWA_CLOAKED
        if (cloaked != 0) return false;
        int ex = GetWindowLong(h, -20);                                            // GWL_EXSTYLE
        if ((ex & 0x80) != 0 || (ex & 0x08000000) != 0) return false;              // WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE
        string c = ClassOf(h);
        if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return false;
        return TitleOf(h).Trim().Length > 0;
    }

    // Runs as administrator. Anything that can't be read counts as yes.
    public static bool Elevated(int pid) {
        IntPtr p = OpenProcess(0x1000, false, pid);                                // PROCESS_QUERY_LIMITED_INFORMATION
        if (p == IntPtr.Zero) return true;
        IntPtr t = IntPtr.Zero;
        try {
            if (!OpenProcessToken(p, 8, out t)) return true;                       // TOKEN_QUERY
            int e, n;
            if (!GetTokenInformation(t, 20, out e, 4, out n)) return true;         // TokenElevation
            return e != 0;
        } finally {
            if (t != IntPtr.Zero) CloseHandle(t);
            CloseHandle(p);
        }
    }
}
'@
} catch {
    Say @{ error = "$($_.Exception.Message)" }
    exit 1
}
try { [UiaProxies]::Register() } catch { }

$AE = [System.Windows.Automation.AutomationElement]
$IP = [System.Windows.Automation.InvokePattern]
$VP = [System.Windows.Automation.ValuePattern]
$RP = [System.Windows.Automation.RangeValuePattern]
$TP = [System.Windows.Automation.TogglePattern]
$SP = [System.Windows.Automation.SelectionItemPattern]
$EP = [System.Windows.Automation.ExpandCollapsePattern]
$XP = [System.Windows.Automation.TextPattern]
$Children = [System.Windows.Automation.TreeScope]::Children
$Any = [System.Windows.Automation.Condition]::TrueCondition

# Kept even when unnamed. An unnamed Pane, Group or Custom is layout only: its children take its place.
$shown = @('Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'Hyperlink', 'MenuItem', 'Menu', 'Tab', 'TabItem',
    'ListItem', 'TreeItem', 'Slider', 'Document', 'DataItem', 'Pane', 'Custom', 'ToolBar', 'Text', 'Group')
# What one fetch brings back for each element, so the walk makes one call per parent and not one per property.
$cached = @($AE::NameProperty, $AE::AutomationIdProperty, $AE::ControlTypeProperty, $AE::ClassNameProperty,
    $AE::HelpTextProperty, $AE::IsEnabledProperty, $AE::IsOffscreenProperty, $AE::IsPasswordProperty,
    $AE::ProcessIdProperty, $AE::NativeWindowHandleProperty, $AE::HasKeyboardFocusProperty,
    $AE::IsInvokePatternAvailableProperty, $AE::IsValuePatternAvailableProperty, $AE::IsTogglePatternAvailableProperty,
    $AE::IsSelectionItemPatternAvailableProperty, $AE::IsExpandCollapsePatternAvailableProperty,
    $AE::IsRangeValuePatternAvailableProperty, $VP::ValueProperty, $VP::IsReadOnlyProperty, $RP::ValueProperty,
    $RP::IsReadOnlyProperty, $TP::ToggleStateProperty, $EP::ExpandCollapseStateProperty, $SP::IsSelectedProperty)

$script:next = 0                                                     # the one id counter: e1, e2, ... never reused
$script:els = New-Object System.Collections.Specialized.OrderedDictionary   # id -> @{ el; hwnd }, the oldest dropped past 2000
$script:sigs = @{}                                                   # hwnd -> what its controls said at the last walk
$script:apps = $null
$SEP = [string][char]31                                              # between the parts of a signature

function Role($type) { return $type.ProgrammaticName -replace '^ControlType\.', '' }
function Number($n) { return ([double]$n).ToString([System.Globalization.CultureInfo]::InvariantCulture) }

# The error means the control is gone.
function Test-Gone($err) {
    for ($x = $err.Exception; $x; $x = $x.InnerException) {
        if ($x -is [System.Windows.Automation.ElementNotAvailableException]) { return $true }
    }
    return $false
}

# -- windows --

# The process a Store (UWP) frame window hosts: every Store app's frame belongs to one ApplicationFrameHost. 0 for
# any other window, and for a frame whose app has not come up yet.
function Get-HostedApp([IntPtr]$h, [string]$cls, [int]$wpid) {
    if ($cls -ne 'ApplicationFrameWindow') { return 0 }
    $core = [Win]::CoreOf($h)
    if ($core -eq [IntPtr]::Zero) { return 0 }
    $cp = [Win]::PidOf($core)
    if ($cp -eq $wpid) { return 0 }
    return $cp
}

function Get-Window([IntPtr]$h) {
    $cls = [Win]::ClassOf($h)
    $wpid = [Win]::PidOf($h)
    $hosted = Get-HostedApp $h $cls $wpid
    if ($hosted) { $wpid = $hosted }
    $app = 'unknown'
    try { $app = [System.Diagnostics.Process]::GetProcessById($wpid).ProcessName } catch { }
    return [ordered]@{ hwnd = $h.ToInt64(); title = [Win]::TitleOf($h); pid = $wpid; app = $app; cls = $cls
        minimized = [Win]::IsIconic($h); elevated = [Win]::Elevated($wpid); hung = [Win]::IsHungAppWindow($h) }
}

# Callers wrap this in @( ): one window alone would otherwise arrive as a bare object.
function Get-Windows {
    foreach ($x in [Win]::All()) {
        $h = [IntPtr]$x
        if ([Win]::Listed($h)) { Get-Window $h }
    }
}

# `fg`: the window in front (desk.ts asks before replacing text in the field the user is in).
function Cmd-Windows {
    return [ordered]@{ ok = $true; fg = [Win]::GetForegroundWindow().ToInt64(); windows = @(Get-Windows) }
}

# -- reading a window --

# The value a node shows: fields only, never a password, 120 characters at most. A Document's ValuePattern is
# always "" (Windows 11 Notepad), so its text comes from TextPattern. A link's value is where it goes (600 at
# most: the Yes card shows it).
function Get-ShownValue($el, $c, [string]$role) {
    if (@('Edit', 'Document', 'ComboBox', 'Spinner', 'Hyperlink') -notcontains $role) { return $null }
    if ($c.IsPassword) { return $null }
    $v = $null
    $x = $el.GetCachedPropertyValue($VP::ValueProperty, $true)
    if ($x -is [string]) { $v = $x }
    if ($null -eq $v -and $role -eq 'Spinner') {
        $x = $el.GetCachedPropertyValue($RP::ValueProperty, $true)
        if ($x -is [double]) { $v = Number $x }
    }
    if ($role -ne 'Hyperlink' -and ($null -eq $v -or ($v -eq '' -and $role -eq 'Document'))) {
        try { $t = $el.GetCurrentPattern($XP::Pattern).DocumentRange.GetText(120); if ($t) { $v = $t } } catch { }
    }
    $max = if ($role -eq 'Hyperlink') { 600 } else { 120 }
    if ($v -and $v.Length -gt $max) { $v = $v.Substring(0, $max) }
    return $v
}

function New-Node($el, $c, [string]$role, [string]$name, [int]$depth, [string]$parent) {
    $has = { param($p) [bool]$el.GetCachedPropertyValue($p) }
    $acts = @()
    $state = @()
    if (& $has $AE::IsInvokePatternAvailableProperty) { $acts += 'press' }
    $set = (& $has $AE::IsValuePatternAvailableProperty) -and -not [bool]$el.GetCachedPropertyValue($VP::IsReadOnlyProperty)
    if (-not $set -and (& $has $AE::IsRangeValuePatternAvailableProperty)) { $set = -not [bool]$el.GetCachedPropertyValue($RP::IsReadOnlyProperty) }
    if ($set) { $acts += 'set' }
    if (& $has $AE::IsTogglePatternAvailableProperty) {
        $acts += 'toggle'
        $state += @{ On = 'on'; Off = 'off'; Indeterminate = 'mixed' }[[string]$el.GetCachedPropertyValue($TP::ToggleStateProperty)]
    }
    if (& $has $AE::IsSelectionItemPatternAvailableProperty) {
        $acts += 'select'
        if ([bool]$el.GetCachedPropertyValue($SP::IsSelectedProperty)) { $state += 'selected' }
    }
    if (& $has $AE::IsExpandCollapsePatternAvailableProperty) {
        $x = [string]$el.GetCachedPropertyValue($EP::ExpandCollapseStateProperty)
        if ($x -ne 'LeafNode') {                                     # a leaf has nothing to open
            $acts += 'expand', 'collapse'
            if ($x -eq 'Collapsed') { $state += 'collapsed' } else { $state += 'expanded' }
        }
    }
    $n = [ordered]@{ id = ''; depth = $depth; parent = $parent; role = $role; name = $name }
    $v = Get-ShownValue $el $c $role
    if ($null -ne $v) { $n.value = $v }
    $n.actions = @($acts)
    if ($state.Count) { $n.state = ($state -join ' ') }
    $n.enabled = [bool]$c.IsEnabled
    $n.offscreen = [bool]$c.IsOffscreen
    $n.password = [bool]$c.IsPassword
    $n.focused = [bool]$c.HasKeyboardFocus
    $n.pid = [int]$c.ProcessId
    $help = [string]$c.HelpText
    $n.help = if ($help -ne $name) { $help } else { '' }
    $n.aid = [string]$c.AutomationId
    return $n
}

# One element of the walk. `$deep`: its children came with it (it was fetched by a search); a child that came that
# way has none of its own yet and is searched in turn, so there is one fetch for every two levels.
# An unnamed layout node is left out and uses up no depth: web views nest 10-15 of them above the first control.
function Walk-Node($w, $el, [int]$depth, [int]$raw, [string]$parent, [bool]$deep) {
    if ($raw -gt 60) { return }
    if ($w.nodes.Count -ge $w.max -or [DateTime]::UtcNow -gt $w.deadline) { $w.truncated = $true; return }
    if ($raw -gt 0) {                                                # the window itself is the list's first line
        try { $c = $el.Cached; $role = Role $c.ControlType; $name = [string]$c.Name } catch { return }
        $named = $name.Trim().Length -gt 0
        $layout = (-not $named) -and ($role -eq 'Pane' -or $role -eq 'Group' -or $role -eq 'Custom')
        if ($named -or (($shown -contains $role) -and -not $layout)) {
            try { $n = New-Node $el $c $role $name $depth $parent } catch { return }
            $w.seen++
            if ($role -eq 'Document') { $w.doc = $true }
            if ($role -eq 'Text' -and $w.text.Length -lt 300) { [void]$w.text.Append($name).Append(' ') }
            [void]$w.sigs.Add("$role$SEP$name$SEP$($n.value)$SEP$($n.state)")
            $f = $w.find
            if (-not $f -or $name.IndexOf($f, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $n.aid.IndexOf($f, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                [void]$w.nodes.Add($n)
                [void]$w.els.Add($el)
            }
            $depth++
            if ($named) { $parent = $name }
        }
    }
    if ($depth -ge 8) { return }
    $kids = $null
    if ($deep) { try { $kids = $el.CachedChildren } catch { $deep = $false } }
    if (-not $deep) { try { $kids = $el.FindAll($Children, $Any) } catch { return } }
    foreach ($k in $kids) { Walk-Node $w $k $depth ($raw + 1) $parent (-not $deep) }
}

# A window's controls: at most $max of them and $budgetMs long (`truncated` when either ran out). With $find, only
# the controls whose name or automation id contains it are kept, but every control is still seen and signed.
# `text`: what the window's first Text nodes say (a box's question), about 300 characters.
function Walk-Window([IntPtr]$h, [int]$max, [int]$budgetMs, [string]$find) {
    $w = @{ nodes = New-Object System.Collections.ArrayList; els = New-Object System.Collections.ArrayList
        sigs = New-Object 'System.Collections.Generic.HashSet[string]'; seen = 0; doc = $false; truncated = $false
        text = New-Object System.Text.StringBuilder
        max = $max; find = $find; deadline = [DateTime]::UtcNow.AddMilliseconds($budgetMs) }
    $cr = New-Object System.Windows.Automation.CacheRequest
    $cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
    $cr.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor $Children
    foreach ($p in $cached) { $cr.Add($p) }
    $on = $cr.Activate()
    try { Walk-Node $w ($AE::FromHandle($h)) 0 0 '' $true } finally { $on.Dispose() }
    return $w
}

function Cmd-Read($cmd) {
    $h = [IntPtr][long]$cmd.hwnd
    if (-not [Win]::Listed($h)) { return @{ ok = $false; code = 'STALE' } }
    if ([Win]::IsHungAppWindow($h)) { return @{ ok = $false; code = 'NOT_RESPONDING' } }
    # A web view builds its tree only once somebody has asked for it: a thin first read is read again, every 700 ms
    # for up to 3 s. A Chromium window is awake when its page (a Document) is there, or when the walk ran out
    # before reaching it. A classic dialog (#32770) is never asleep, however few controls it has.
    $cls = [Win]::ClassOf($h)
    $chromium = $cls -eq 'Chrome_WidgetWin_1'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        # It closed since it was listed: STALE, not an error.
        try { $w = Walk-Window $h 400 4000 ([string]$cmd.find) } catch { if ([Win]::Listed($h)) { throw }; return @{ ok = $false; code = 'STALE' } }
        $awake = if ($chromium) { $w.doc -or $w.truncated } else { $w.seen -ge 10 -or $cls -eq '#32770' }
        if ($awake -or $sw.ElapsedMilliseconds -ge 3000) { break }
        Start-Sleep -Milliseconds 700
    }
    # `from`: the highest id Blob has seen. A bridge that was started again goes on from there: no id comes twice.
    if ([int]$cmd.from -gt $script:next) { $script:next = [int]$cmd.from }
    for ($i = 0; $i -lt $w.nodes.Count; $i++) {
        $script:next++
        $w.nodes[$i].id = "e$($script:next)"
        $script:els["e$($script:next)"] = @{ el = $w.els[$i]; hwnd = $h }
    }
    while ($script:els.Count -gt 2000) { $script:els.RemoveAt(0) }
    if ($script:sigs.Count -gt 50) { foreach ($k in @($script:sigs.Keys)) { if (-not [Win]::Listed([IntPtr]$k)) { $script:sigs.Remove($k) } } }   # closed windows
    $script:sigs[$h.ToInt64()] = $w.sigs
    $r = [ordered]@{ ok = $true; nodes = @($w.nodes); text = $w.text.ToString().Trim() }
    if ($w.truncated) { $r.truncated = $true }
    if ($chromium -and -not $w.doc -and -not $w.truncated) { $r.noDocument = $true }
    return $r
}

function Get-El($id) {
    $id = [string]$id
    if ($id -and $script:els.Contains($id)) { return $script:els[$id] }
    return $null
}

# A field's own value: its text, or its number.
function Read-Field($el) {
    try { return [string]$el.GetCurrentPattern($VP::Pattern).Current.Value } catch { if (Test-Gone $_) { throw } }
    try { return Number ($el.GetCurrentPattern($RP::Pattern).Current.Value) } catch { if (Test-Gone $_) { throw } }
    return $null
}

function Cmd-Value($cmd) {
    $e = Get-El $cmd.el
    if (-not $e) { return @{ ok = $false; code = 'STALE' } }
    $el = $e.el
    try {
        if ($el.Current.IsPassword) { return @{ ok = $false; code = 'PASSWORD' } }
        $doc = (Role $el.Current.ControlType) -eq 'Document'       # a web page's value is its address: its text comes first
        $v = $null
        if (-not $doc) { $v = Read-Field $el }
        if (-not $v) {
            try { $t = $el.GetCurrentPattern($XP::Pattern).DocumentRange.GetText(-1); if ($null -eq $v -or $t) { $v = $t } } catch { if (Test-Gone $_) { throw } }
        }
        if ($doc -and -not $v) { $v = Read-Field $el }
        if ($null -eq $v) { $v = [string]$el.Current.Name }         # it holds no text at all: a label, a button
    } catch {
        if (Test-Gone $_) { return @{ ok = $false; code = 'STALE' } }
        throw
    }
    if ($v.Length -gt 8000) { $v = $v.Substring(0, 8000) }
    return @{ ok = $true; value = $v }
}

# -- acting --

# The windows of one app: what a press opened or closed is told from them.
function Get-AppWindows([int]$id) {
    foreach ($w in @(Get-Windows)) { if ($w.pid -eq $id) { @{ hwnd = $w.hwnd; title = $w.title } } }
}

# What a call on the worker said, as a reply; nothing when it finished.
function Get-Unfinished([string]$s) {
    if ($s -eq 'pending') { return @{ ok = $true; pending = $true } }
    if ($s -ne 'ok') { return @{ ok = $false; code = 'CANT_PRESS'; message = $s.Substring(6) } }
}

# What the window says now that it did not say at the last walk (5 at most); this walk is then the last one.
# It runs after every step, so a press is never told of what a set or a toggle before it changed.
function Get-Changed([IntPtr]$h) {
    $changed = @()
    if ([Win]::Listed($h) -and -not [Win]::IsHungAppWindow($h)) {
        $old = $script:sigs[$h.ToInt64()]
        $w = Walk-Window $h 400 1500 ''
        if ($old) {
            foreach ($sig in $w.sigs) {
                if ($old.Contains($sig)) { continue }
                $role, $name, $val, $st = $sig.Split($SEP)
                $t = if ($name.Trim()) { $name } elseif ($val -or $st) { $role } else { '' }
                if (-not $t) { continue }
                if ($val) { $t = "$t = $val" }
                if ($st) { $t = "$t $st" }
                $changed += $t
                if ($changed.Count -ge 5) { break }
            }
        }
        $script:sigs[$h.ToInt64()] = $w.sigs
    }
    return $changed
}

function Do-Press($el, [IntPtr]$h, [int]$owner, $before) {
    $no = Get-Unfinished ([UiaInvoker]::Invoke($el.GetCurrentPattern($IP::Pattern), 1500))
    if ($no) { return $no }
    Start-Sleep -Milliseconds 300
    $changed = @(Get-Changed $h)
    $gone = $false
    try { [void]$el.Current.Name } catch { $gone = $true }
    $after = @(Get-AppWindows $owner)
    $opened = @($after | Where-Object { $x = $_.hwnd; -not ($before | Where-Object { $_.hwnd -eq $x }) })
    $closed = @($before | Where-Object { $x = $_.hwnd; -not ($after | Where-Object { $_.hwnd -eq $x }) }).Count
    return [ordered]@{ ok = $true; changed = @($changed); opened = @($opened); closed = $closed; gone = $gone }
}

function Do-Set($el, [string]$value) {
    # The edit inside a Win32 combo box (the file dialog's File name) takes the text and reads it back, but its
    # owner is never told: Save would write the old name. That one is typed, on the screen.
    $dad = $null
    try { $dad = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($el) } catch { if (Test-Gone $_) { throw } }
    if ($dad -and $dad.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $el.Current.NativeWindowHandle -ne 0) {
        return @{ ok = $false; code = 'NOT_IN_BACKGROUND' }
    }
    $before = Read-Field $el
    $vp = $null
    try { $vp = $el.GetCurrentPattern($VP::Pattern) } catch { if (Test-Gone $_) { throw } }
    if ($vp -and -not $vp.Current.IsReadOnly) { $s = [UiaInvoker]::SetValue($vp, $value, 1500) }
    else {
        $num = 0.0
        if (-not [double]::TryParse($value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$num)) { throw 'this field cannot be set' }
        $s = [UiaInvoker]::SetNumber($el.GetCurrentPattern($RP::Pattern), $num, 1500)
    }
    $no = Get-Unfinished $s
    if ($no) { return $no }
    return [ordered]@{ ok = $true; before = $before; after = (Read-Field $el) }
}

# Reads $read until $done says it is there, or 500 ms: Chromium updates its tree after the call returns.
function Wait-State([scriptblock]$read, [scriptblock]$done) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        $now = & $read
        if (& $done $now) { break }
        Start-Sleep -Milliseconds 50
    } while ($sw.ElapsedMilliseconds -lt 500)
    return $now
}

function Do-Action($el, [string]$action, $cmd, [IntPtr]$h, [int]$owner, $before) {
    if ($action -eq 'press') { return Do-Press $el $h $owner $before }
    if ($action -eq 'set') { return Do-Set $el ([string]$cmd.value) }
    if ($action -eq 'toggle') {
        $p = $el.GetCurrentPattern($TP::Pattern)
        $was = [string]$p.Current.ToggleState
        $no = Get-Unfinished ([UiaInvoker]::Toggle($p, 1500))
        if ($no) { return $no }
        $now = Wait-State { [string]$p.Current.ToggleState } { param($s) $s -ne $was }
        return [ordered]@{ ok = $true; before = $was; after = $now }
    }
    if ($action -eq 'select') {
        $p = $el.GetCurrentPattern($SP::Pattern)
        $no = Get-Unfinished ([UiaInvoker]::Select($p, 1500))
        if ($no) { return $no }
        return @{ ok = $true; selected = [bool](Wait-State { [bool]$p.Current.IsSelected } { param($s) $s }) }
    }
    if ($action -eq 'expand' -or $action -eq 'collapse') {
        $p = $el.GetCurrentPattern($EP::Pattern)
        $was = [string]$p.Current.ExpandCollapseState
        $open = $action -eq 'expand'
        $s = if ($open) { [UiaInvoker]::Expand($p, 1500) } else { [UiaInvoker]::Collapse($p, 1500) }
        if ($s -eq 'pending') { return @{ ok = $true; pending = $true } }
        if ($s -ne 'ok') { return @{ ok = $false; code = 'NOT_IN_BACKGROUND'; message = $s.Substring(6) } }
        $now = Wait-State { [string]$p.Current.ExpandCollapseState } { param($x) ($x -ne 'Collapsed') -eq $open }
        return [ordered]@{ ok = $true; before = $was; after = $now }
    }
    throw "unknown action: $action"
}

# Windows works a classic (Win32, WinForms) control for the desk, and for most kinds it does so with real keys, a
# real click or by raising the window: menus, toolbar, list and tree items, combo boxes, title-bar buttons, and
# every control known only through MSAA (no framework id). The desk works only the kinds that take a plain message:
# a real button, check box or radio button, a tab, and a field with a window of its own.
function Test-NeedsFront($cur, [string]$role, [string]$action) {
    $fw = [string]$cur.FrameworkId
    if ($fw -ne 'Win32' -and $fw -ne 'WinForm' -and $fw -ne '') { return $false }   # the app's own provider
    if ($action -eq 'set') { return $fw -ne '' -and $cur.NativeWindowHandle -eq 0 } # a list item's label
    if ($fw -eq '') { return $true }
    if ($role -eq 'TabItem') { return $action -ne 'select' }
    return -not ($cur.NativeWindowHandle -ne 0 -and $cur.ClassName -match 'button' -and @('Button', 'CheckBox', 'RadioButton') -contains $role)
}

function Cmd-Act($cmd) {
    $e = Get-El $cmd.el
    if (-not $e) { return @{ ok = $false; code = 'STALE' } }
    $el = $e.el
    $h = $e.hwnd
    # Still the control that was read: the same name and kind. Anything else, or gone, is STALE.
    try {
        $cur = $el.Current
        if ([string]$cur.Name -cne [string]$cmd.expectName -or (Role $cur.ControlType) -cne [string]$cmd.expectRole) { return @{ ok = $false; code = 'STALE' } }
        if (Test-NeedsFront $cur (Role $cur.ControlType) ([string]$cmd.action)) { return @{ ok = $false; code = 'NOT_IN_BACKGROUND' } }
    } catch { return @{ ok = $false; code = 'STALE' } }
    if ([Win]::IsHungAppWindow($h)) { return @{ ok = $false; code = 'NOT_RESPONDING' } }
    $front = [Win]::GetForegroundWindow()
    $at = [Win]::Cursor()
    $owner = [Win]::PidOf($h)
    $hosted = Get-HostedApp $h ([Win]::ClassOf($h)) $owner
    if ($hosted) { $owner = $hosted }
    # A Store app comes to the front when one of its controls is worked (seen live: Calculator's buttons), so the
    # desk works one only while it is already in front. Its front window may be the frame or the app's own window.
    if ([Win]::ClassOf($h) -eq 'ApplicationFrameWindow' -and $front -ne $h -and -not ($hosted -and [Win]::PidOf($front) -eq $hosted)) { return @{ ok = $false; code = 'NOT_IN_BACKGROUND' } }
    $before = @(Get-AppWindows $owner)
    $action = [string]$cmd.action
    try { $r = Do-Action $el $action $cmd $h $owner $before } catch {
        if (Test-Gone $_) { $r = @{ ok = $false; code = 'STALE' } }
        else { $r = @{ ok = $false; code = 'CANT_PRESS'; message = "$($_.Exception.Message)" } }
    }
    if ($r.ok -and -not $r.pending -and $action -ne 'press') { [void]@(Get-Changed $h) }
    # The desk never takes the front or the pointer; a UIA provider inside the app might. Said on every reply.
    $r.fgChanged = [Win]::GetForegroundWindow() -ne $front
    $r.cursorMoved = [Win]::Cursor() -ne $at
    $late = [UiaInvoker]::TakeLateError()
    if ($late) { $r.lateError = $late }
    return $r
}

# -- opening an app --

# The Start menu's apps (name and AppID), listed again after 60 s.
function Get-Apps {
    if (-not $script:apps -or ((Get-Date) - $script:appsAt).TotalSeconds -ge 60) {
        $list = @()
        foreach ($i in (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').Items()) {
            $list += @{ name = [string]$i.Name; id = [string]$i.Path }
        }
        $script:apps = $list
        $script:appsAt = Get-Date
    }
    return $script:apps
}

function Cmd-Open($cmd) {
    $q = ([string]$cmd.name).Trim()
    $apps = @(Get-Apps)
    $ci = [StringComparison]::OrdinalIgnoreCase
    $names = { param($list) @($list | ForEach-Object { $_.name } | Select-Object -Unique -First 5) }
    $hit = @()
    if ($q) { $hit = @($apps | Where-Object { $_.name.Equals($q, $ci) } | Select-Object -First 1) }
    if (-not $hit.Count -and $q) {
        $hit = @($apps | Where-Object { $_.name.StartsWith($q, $ci) })
        if (-not $hit.Count) { $hit = @($apps | Where-Object { $_.name.IndexOf($q, $ci) -ge 0 }) }
        if ($hit.Count -gt 1) { return @{ ok = $false; code = 'AMBIGUOUS'; names = @(& $names $hit) } }
    }
    if (-not $hit.Count) {
        $words = @($q -split '\s+' | Where-Object { $_.Length -gt 1 })
        $near = @($apps | Where-Object { $n = $_.name; @($words | Where-Object { $n.IndexOf($_, $ci) -ge 0 }).Count -gt 0 })
        return @{ ok = $false; code = 'NOT_FOUND'; names = @(& $names $near) }
    }
    $app = $hit[0]
    # An installer changes the computer: that goes through a command, which asks. And nothing that could add to explorer's command line.
    # "install" anywhere in the name also covers Uninstaller, Deinstallieren and Desinstaller.
    if ($app.name -match 'install|desinstal|\b(setup|remove)\b' -or $app.id -match 'unins\d*\.exe|uninstall|setup\.exe|msiexec|["\r\n]') { return @{ ok = $false; code = 'NOT_APP' } }
    $old = @(Get-Windows | ForEach-Object { $_.hwnd })
    $front = [Win]::GetForegroundWindow().ToInt64()
    Start-Process explorer.exe -ArgumentList "`"shell:AppsFolder\$($app.id)`""
    # Its window: a new one, or one the app brought to the front. A window that was already there (a browser tab
    # with the app's name in its title) is taken only when the 5 s bring nothing else.
    $win = $null
    $was = $null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 250
        $fg = [Win]::GetForegroundWindow().ToInt64()
        foreach ($w in @(Get-Windows)) {
            if ($w.title.IndexOf($app.name, $ci) -lt 0 -and $w.app.IndexOf($app.name, $ci) -lt 0) { continue }
            if ($old -notcontains $w.hwnd -or ($w.hwnd -eq $fg -and $fg -ne $front)) { $win = $w; break }
            if (-not $was) { $was = $w }
        }
    } while (-not $win -and $sw.ElapsedMilliseconds -lt 5000)
    if (-not $win) { $win = $was }
    $r = [ordered]@{ ok = $true; app = $app.name }
    if ($win) { $r.window = @{ hwnd = $win.hwnd; title = $win.title } }
    return $r
}

# -- main: say ready, then one reply line for each command line --
Say @{ ready = $true }
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }                                   # Blob closed
    if (-not $line.Trim()) { continue }
    try {
        $cmd = $line | ConvertFrom-Json
        $r = switch ($cmd.cmd) {
            'windows' { Cmd-Windows }
            'read'    { Cmd-Read $cmd }
            'value'   { Cmd-Value $cmd }
            'act'     { Cmd-Act $cmd }
            'open'    { Cmd-Open $cmd }
            default   { @{ error = "unknown command: $($cmd.cmd)" } }
        }
    } catch { $r = @{ error = "$($_.Exception.Message)" } }
    Say $r
}
