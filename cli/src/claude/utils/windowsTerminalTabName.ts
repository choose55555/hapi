import { spawn } from 'node:child_process';

export const PROMPT_FRAGMENT_MIN = 4;
export const PROMPT_FRAGMENT_MAX = 24;
export const TERMINAL_TAB_NAME_SOURCE = 'terminal-tab';
const TERMINAL_TEXT_CAP = 200_000;
// Cold start of UI Automation was measured at 3026 ms, so 3 seconds timed out.
export const READ_TIMEOUT_MS = 8_000;

export type SelectedTab = { name: string; text: string };

export type TabReadResult = { stdout: string; timedOut: boolean; exitCode: number | null };

const PROGRAM_TITLE_PREFIXES = ['✳', '[Claude]', '[Workbench]'] as const;

/**
 * PowerShell 5.1 + UIAutomationClient. ASCII only, so -Command does not depend
 * on the console code page. Failures print [] and the caller keeps the old name.
 * TextPattern is capped at 200000 characters: a measured selected-tab buffer was
 * about 18000, and the prompt just submitted sits in that window. A longer buffer
 * that drops the prompt is treated as "not read accurately" and does not rename.
 */
export const WINDOWS_TERMINAL_TAB_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
function Write-Out([string]$value) {
  $bytes = $utf8.GetBytes($value)
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
}
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $winCond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($win in $windows) {
    $text = ''
    try {
      $termCond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')
      $term = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $termCond)
      if ($null -ne $term) {
        $pattern = $term.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($null -ne $pattern) { $text = $pattern.DocumentRange.GetText(${TERMINAL_TEXT_CAP}) }
      }
    } catch { $text = '' }
    $tabCond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
    $tabs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
    foreach ($tab in $tabs) {
      $selected = $false
      try {
        $selection = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($null -ne $selection) { $selected = [bool]$selection.Current.IsSelected }
      } catch { $selected = $false }
      if (-not $selected) { continue }
      $items.Add([pscustomobject]@{ name = [string]$tab.Current.Name; text = [string]$text })
    }
  }
  if ($items.Count -eq 0) { Write-Out '[]' } else { Write-Out (ConvertTo-Json -Compress -InputObject @($items.ToArray())) }
} catch {
  Write-Out '[]'
}
`.trim();

export function stripWhitespace(value: string): string {
    return value.replace(/[\s\u00a0\u3000\ufeff]+/g, '');
}

/**
 * Opening of the prompt after whitespace is removed.
 * Under 4 characters is not judged: short text such as "你好" appears in many
 * terminals and would rename the wrong session. 24 characters is enough to
 * tell ordinary sentences apart, and short enough that line wrapping or a
 * capped terminal buffer still contains the opening the user just submitted.
 */
export function promptMatchFragment(prompt: string): string | null {
    const stripped = stripWhitespace(prompt);
    if (stripped.length < PROMPT_FRAGMENT_MIN) return null;
    return stripped.slice(0, PROMPT_FRAGMENT_MAX);
}

export function isUsableTabName(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return !PROGRAM_TITLE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function chooseTabName(prompt: string, tabs: readonly SelectedTab[]): string | null {
    const fragment = promptMatchFragment(prompt);
    if (!fragment) return null;
    const hits = tabs.filter((tab) => stripWhitespace(tab.text).includes(fragment));
    if (hits.length !== 1) return null;
    const name = hits[0].name.trim();
    if (!isUsableTabName(name)) return null;
    return name;
}

export function parseSelectedTabs(stdout: string): SelectedTab[] | null {
    const trimmed = stdout.replace(/^\uFEFF/, '').trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const tabs: SelectedTab[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const record = item as { name?: unknown; text?: unknown };
        if (typeof record.name !== 'string' || typeof record.text !== 'string') continue;
        tabs.push({ name: record.name, text: record.text });
    }
    return tabs;
}

export function runPowerShellHidden(script: string, timeoutMs = READ_TIMEOUT_MS): Promise<TabReadResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: TabReadResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-WindowStyle', 'Hidden',
                '-ExecutionPolicy', 'Bypass',
                '-Command', script
            ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            finish({ stdout: '', timedOut: false, exitCode: null });
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        child.stdout?.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
                child.kill();
                return;
            }
            chunks.push(chunk);
        });
        const timer = setTimeout(() => {
            child.kill();
            finish({ stdout: '', timedOut: true, exitCode: null });
        }, timeoutMs);
        child.on('error', () => {
            clearTimeout(timer);
            finish({ stdout: '', timedOut: false, exitCode: null });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            finish({ stdout: Buffer.concat(chunks).toString('utf8'), timedOut: false, exitCode: code });
        });
    });
}

export async function readSelectedWindowsTerminalTabs(options?: {
    platform?: string;
    run?: (script: string) => Promise<TabReadResult>;
    timeoutMs?: number;
}): Promise<SelectedTab[] | null> {
    const platform = options?.platform ?? process.platform;
    if (platform !== 'win32') return null;
    try {
        const run = options?.run ?? ((script: string) => runPowerShellHidden(script, options?.timeoutMs ?? READ_TIMEOUT_MS));
        const result = await run(WINDOWS_TERMINAL_TAB_SCRIPT);
        if (result.timedOut || result.exitCode !== 0) return null;
        return parseSelectedTabs(result.stdout);
    } catch {
        return null;
    }
}

export type TabNameSyncInput = {
    platform: string;
    mode: string | undefined;
    prompt: unknown;
    isPhoneInject: (prompt: string) => boolean;
    readTabs: () => Promise<readonly SelectedTab[] | null>;
    currentName: () => string | undefined;
    currentNameSource?: () => string | undefined;
    applyName: (name: string) => void;
};

export async function syncLocalWindowsTerminalTabName(input: TabNameSyncInput): Promise<'skipped' | 'kept' | 'renamed'> {
    try {
        if (input.platform !== 'win32') return 'skipped';
        if (input.mode !== 'local') return 'skipped';
        if (typeof input.prompt !== 'string') return 'skipped';
        if (promptMatchFragment(input.prompt) === null) return 'skipped';
        if (input.isPhoneInject(input.prompt)) return 'skipped';
        const tabs = await input.readTabs();
        if (tabs === null) return 'kept';
        const name = chooseTabName(input.prompt, tabs);
        if (!name) return 'kept';
        if (input.currentName() === name && input.currentNameSource?.() === TERMINAL_TAB_NAME_SOURCE) return 'kept';
        input.applyName(name);
        return 'renamed';
    } catch {
        return 'kept';
    }
}
