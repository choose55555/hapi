import { spawn } from 'node:child_process';

export const PROMPT_FRAGMENT_MIN = 4;
export const PROMPT_FRAGMENT_MAX = 24;
export const TERMINAL_TAB_NAME_SOURCE = 'terminal-tab';
export const FIXED_SESSION_NAME_SOURCE = 'fixed';
const TERMINAL_TEXT_CAP = 200_000;
// Cold start of UI Automation was measured at 3026 ms, so 3 seconds timed out.
export const READ_TIMEOUT_MS = 8_000;
export const TAB_RESULT_MAX_AGE_MS = 1_500;

export type TabNameSyncState = {
    turn: number;
    pendingName?: string;
    pendingFromName?: string;
    pendingPromptKey?: string;
};
export function createTabNameSyncState(): TabNameSyncState {
    return { turn: 0 };
}

export type SelectedTab = { name: string; text: string };

export type TabReadResult = { stdout: string; timedOut: boolean; exitCode: number | null };

const PROGRAM_TITLE_PREFIXES = [
    '✳',
    '[Claude]',
    '[Claude/',
    '[Codex]',
    '[Codex/',
    '[Workbench]',
    '[Workbench/'
] as const;

// Claude Code writes native busy titles starting with Braille spinner glyphs
// (confirmed by scripts/workbench-lib.ps1:1339). Treat them as program titles
// (REJECT), NEVER strip them into fake user tab names.
const CLAUDE_BRAILLE_TITLE_PREFIX = /^[\u2800-\u28ff]/u;

// Workbench-owned transient status/spinner prefixes ONLY.
// CRITICAL (Revision 3 fix per Codex review): NEVER include '✳' (\u2733) or
// Braille (\u2800-\u28ff) here — those are Claude Code's own program title
// markers and MUST be rejected by isProgramTitle() before and after stripping.
const DYNAMIC_TITLE_PREFIX_PATTERNS: readonly RegExp[] = [
    // Workbench dynamic status prefixes written by scripts/workbench-lib.ps1:1347-1348
    /^(?:\u25b6\s*推进|\u270b\s*等你|\u2714\s*完成)\s*\|\s*/u,
    // Historical workbench tab progress spinner glyphs (◐◑◒◓ ONLY)
    /^[\u25d0\u25d1\u25d2\u25d3]\s*/u
];

// Covers ALL zones in scripts/doctor_config.json `zones` table (common, xutuan,
// qinan, tender, indonesia, pan2, qianyingzi, aftersales, digitalhub, qtt,
// edumedia, chatgpt-archive) plus legacy/alias prefixes and launcher tool codes.
const GENERATED_WINDOW_LABEL_PATTERNS: readonly RegExp[] = [
    /^(?:common|xutuan|qinan|tender|indonesia|pan2|qianyingzi|aftersales|digitalhub|qtt|edumedia|chatgpt-archive|lanyan|lanyan-bid|tender-common|zhuxianzhuang|obsidian|obs|zone)-(?:clau|code|codex|agy|anti|kimi|grok|qwen|dsh)-[0-9a-f]{4}-\d+$/i,
    /^(?:common|xutuan|qinan|tender|indonesia|pan2|qianyingzi|aftersales|digitalhub|qtt|edumedia|chatgpt-archive|lanyan|lanyan-bid|tender-common|zhuxianzhuang|obsidian|obs|zone)-[0-9a-f]{4}$/i
];

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

export function isProgramTitle(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (PROGRAM_TITLE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
    if (CLAUDE_BRAILLE_TITLE_PREFIX.test(trimmed)) return true;
    return false;
}

/**
 * Strip transient workbench status/spinner prefixes while preserving the real
 * user-facing tab label behind them (e.g. "▶ 推进 | 许疃" -> "许疃").
 * Never strips Claude program title prefixes ('✳' or Braille spinners).
 */
export function stripDynamicTitlePrefixes(rawName: string): string {
    let current = rawName.trim();
    for (let step = 0; step < 8 && current.length > 0; step += 1) {
        if (isProgramTitle(current)) break;
        let next = current;
        for (const pattern of DYNAMIC_TITLE_PREFIX_PATTERNS) {
            next = next.replace(pattern, '').trim();
        }
        if (next === current) break;
        current = next;
    }
    return current;
}

/**
 * Opening of the prompt after whitespace is removed.
 * Kept exported for backward compatibility with existing callers/tests.
 */
export function promptMatchFragment(prompt: string): string | null {
    const stripped = stripWhitespace(prompt);
    if (stripped.length < PROMPT_FRAGMENT_MIN) return null;
    return stripped.slice(0, PROMPT_FRAGMENT_MAX);
}

/**
 * Stronger prompt anchor(s) for unlocked windows:
 * For prompts longer than 24 chars, require BOTH the opening 24-char anchor AND
 * a non-overlapping closing anchor so two windows sharing a common instruction
 * prefix (e.g. "请帮我核查...甲" vs "请帮我核查...乙") cannot cross-match.
 */
export function promptMatchAnchors(prompt: string): { head: string; tail: string | null } | null {
    const stripped = stripWhitespace(prompt);
    if (stripped.length < PROMPT_FRAGMENT_MIN) return null;
    const head = stripped.slice(0, PROMPT_FRAGMENT_MAX);
    if (stripped.length <= PROMPT_FRAGMENT_MAX) {
        return { head, tail: null };
    }
    const tailLen = Math.min(PROMPT_FRAGMENT_MAX, stripped.length - PROMPT_FRAGMENT_MAX);
    const tail = stripped.slice(-tailLen);
    return { head, tail };
}

export function isUsableTabName(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    // Reject program titles BEFORE stripping workbench prefixes so '✳ ...' and
    // Braille auto-titles are never stripped into seemingly usable labels.
    if (isProgramTitle(trimmed)) return false;
    const cleaned = stripDynamicTitlePrefixes(trimmed);
    if (!cleaned) return false;
    // Also reject program titles AFTER stripping workbench status wrappers
    // (e.g. '▶ 推进 | ✳ Claude Code' or '▶ 推进 | [Claude/common] ...').
    if (isProgramTitle(cleaned)) return false;
    if (GENERATED_WINDOW_LABEL_PATTERNS.some((pattern) => pattern.test(cleaned))) return false;
    return true;
}

export function chooseTabName(prompt: string, tabs: readonly SelectedTab[]): string | null {
    const anchors = promptMatchAnchors(prompt);
    if (!anchors) return null;
    const hits = tabs.filter((tab) => {
        const normalizedText = stripWhitespace(tab.text);
        const headIdx = normalizedText.indexOf(anchors.head);
        if (headIdx === -1) return false;
        if (anchors.tail === null) return true;
        return normalizedText.indexOf(anchors.tail, headIdx + anchors.head.length) !== -1;
    });
    if (hits.length !== 1) return null;
    const rawName = hits[0].name;
    if (!isUsableTabName(rawName)) return null;
    const cleaned = stripDynamicTitlePrefixes(rawName);
    return cleaned || null;
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
    isTitleLocked?: () => boolean;
    disableTabGuess?: boolean;
    /**
     * Require two consecutive turns reading the same normalized tab name even
     * on the initial rename (defaults to true so a single tab switch or shared
     * prompt cannot misname an unlocked window).
     */
    requireTwoReadsForInitial?: boolean;
    applyName: (name: string) => void;
    submittedAt?: number;
    now?: () => number;
    state?: TabNameSyncState;
};

export async function syncLocalWindowsTerminalTabName(input: TabNameSyncInput): Promise<'skipped' | 'kept' | 'renamed'> {
    const state = input.state ?? createTabNameSyncState();
    const turn = ++state.turn;
    const previousCandidate = state.pendingName;
    const previousFromName = state.pendingFromName;
    const previousPromptKey = state.pendingPromptKey;
    state.pendingName = undefined;
    state.pendingFromName = undefined;
    state.pendingPromptKey = undefined;
    try {
        const now = input.now ?? Date.now;
        const submittedAt = input.submittedAt ?? now();
        const fresh = () => {
            const age = now() - submittedAt;
            return Number.isFinite(age) && age >= 0 && age <= TAB_RESULT_MAX_AGE_MS;
        };
        if (input.platform !== 'win32') return 'skipped';
        if (input.mode !== 'local') return 'skipped';
        if (input.disableTabGuess === true) return 'skipped';
        if (input.isTitleLocked?.()) return 'skipped';
        if (input.currentNameSource?.() === FIXED_SESSION_NAME_SOURCE) return 'skipped';
        if (typeof input.prompt !== 'string') return 'skipped';
        const anchors = promptMatchAnchors(input.prompt);
        if (anchors === null) return 'skipped';
        if (input.isPhoneInject(input.prompt)) return 'skipped';
        if (!fresh()) return 'kept';
        const originalName = input.currentName();
        const originalSource = input.currentNameSource?.();
        const tabs = await input.readTabs();
        if (state.turn !== turn || !fresh()) return 'kept';
        if (input.disableTabGuess === true || input.isTitleLocked?.() || input.currentNameSource?.() === FIXED_SESSION_NAME_SOURCE) return 'kept';
        if (input.currentName() !== originalName || input.currentNameSource?.() !== originalSource) return 'kept';
        if (tabs === null) return 'kept';
        const name = chooseTabName(input.prompt, tabs);
        if (!name) return 'kept';
        if (input.currentName() === name && input.currentNameSource?.() === TERMINAL_TAB_NAME_SOURCE) return 'kept';

        const promptKey = `${anchors.head}|${anchors.tail ?? ''}`;
        const requireTwoReads = input.requireTwoReadsForInitial ?? true;
        const isExistingTabRename = Boolean(originalName?.trim() && originalSource === TERMINAL_TAB_NAME_SOURCE);
        const needsConfirmation = isExistingTabRename || requireTwoReads;

        if (needsConfirmation) {
            const sameCandidate = previousCandidate === name && previousFromName === (originalName ?? '');
            const distinctPromptOrExisting = isExistingTabRename || previousPromptKey !== promptKey;
            if (!sameCandidate || !distinctPromptOrExisting) {
                state.pendingName = name;
                state.pendingFromName = originalName ?? '';
                state.pendingPromptKey = promptKey;
                return 'kept';
            }
        }
        input.applyName(name);
        return 'renamed';
    } catch {
        return 'kept';
    }
}
