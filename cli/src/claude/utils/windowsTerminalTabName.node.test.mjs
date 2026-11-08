import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    READ_TIMEOUT_MS,
    TERMINAL_TAB_NAME_SOURCE,
    WINDOWS_TERMINAL_TAB_SCRIPT,
    chooseTabName,
    parseSelectedTabs,
    promptMatchFragment,
    readSelectedWindowsTerminalTabs,
    syncLocalWindowsTerminalTabName
} from './windowsTerminalTabName.ts';
import {
    TERMINAL_TAB_NAME_SOURCE as RENAME_TAB_NAME_SOURCE,
    applySessionDisplayRename,
    changeTitleResultIfTerminalTab,
    changeTitleToolText
} from '../../agent/sessionDisplayRename.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const prompt = '列出这个文件夹里有哪些文件';

function harness(overrides = {}) {
    const calls = { read: 0, apply: [] };
    const input = {
        platform: 'win32',
        mode: 'local',
        prompt,
        isPhoneInject: () => false,
        readTabs: async () => {
            calls.read += 1;
            return [{ name: '许疃报告', text: '前面的字\n列出这个文件夹里有哪些文件\n后面' }];
        },
        currentName: () => undefined,
        applyName: (name) => { calls.apply.push(name); },
        ...overrides
    };
    return { input, calls };
}

test('fragment skips text shorter than 4 and keeps 24 opening characters', () => {
    assert.equal(promptMatchFragment('你好'), null);
    assert.equal(promptMatchFragment('你 好'), null);
    assert.equal(promptMatchFragment('abcd'), 'abcd');
    assert.equal(promptMatchFragment('  你 好 世 界  '), '你好世界');
    const long = '一二三四五六七八九十一二三四五六七八九十多出来啊';
    assert.equal(promptMatchFragment(long).length, 24);
});

test('exactly one selected tab with the prompt adopts its name', () => {
    const tabs = [
        { name: '许疃报告', text: '列出\n这个文件夹里有哪些文件' },
        { name: '手机遥控', text: '另一句完全不同的话在这个窗口' }
    ];
    assert.equal(chooseTabName(prompt, tabs), '许疃报告');
});

test('zero hits, two hits, and program titles do not rename', () => {
    assert.equal(chooseTabName(prompt, [{ name: '许疃报告', text: '没有这句话' }]), null);
    assert.equal(chooseTabName(prompt, [
        { name: '甲', text: prompt },
        { name: '乙', text: `也包含${prompt}` }
    ]), null);
    assert.equal(chooseTabName(prompt, [{ name: '', text: prompt }]), null);
    assert.equal(chooseTabName(prompt, [{ name: '✳ Claude Code', text: prompt }]), null);
    assert.equal(chooseTabName(prompt, [{ name: '[Claude] - workbench - MENU', text: prompt }]), null);
    assert.equal(chooseTabName(prompt, [{ name: '[Workbench] menu', text: prompt }]), null);
    assert.equal(chooseTabName(prompt, [
        { name: '✳ Claude Code', text: prompt },
        { name: '许疃报告', text: prompt }
    ]), null);
});

test('a later tab rename replaces the previous session name', async () => {
    const { input, calls } = harness({ currentName: () => '旧名字' });
    assert.equal(await syncLocalWindowsTerminalTabName(input), 'renamed');
    assert.deepEqual(calls.apply, ['许疃报告']);
});

test('the same tab name is not written again once its source is recorded', async () => {
    const { input, calls } = harness({
        currentName: () => '许疃报告',
        currentNameSource: () => TERMINAL_TAB_NAME_SOURCE
    });
    assert.equal(await syncLocalWindowsTerminalTabName(input), 'kept');
    assert.deepEqual(calls.apply, []);
});

test('a matching tab name without a recorded source is written so later renames cannot cover it', async () => {
    const { input, calls } = harness({ currentName: () => '许疃报告' });
    assert.equal(await syncLocalWindowsTerminalTabName(input), 'renamed');
    assert.deepEqual(calls.apply, ['许疃报告']);
});

test('the automation script uses TextPattern and the read timeout is 8 seconds', () => {
    assert.match(WINDOWS_TERMINAL_TAB_SCRIPT, /\[System\.Windows\.Automation\.TextPattern\]::Pattern/);
    assert.doesNotMatch(WINDOWS_TERMINAL_TAB_SCRIPT, /\.Text\.TextPattern\]/);
    assert.equal(READ_TIMEOUT_MS, 8000);
    assert.equal(TERMINAL_TAB_NAME_SOURCE, 'terminal-tab');
    assert.equal(RENAME_TAB_NAME_SOURCE, TERMINAL_TAB_NAME_SOURCE);
});

test('change_title keeps a terminal tab name, and a later tab sync can still replace it', async () => {
    let metadata = { path: '/tmp', host: 'local', name: '旧名字', summary: { text: '旧摘要', updatedAt: 1 } };
    const client = {
        updateMetadata(handler) { metadata = handler(metadata); }
    };
    const { input } = harness({
        currentName: () => metadata.name,
        currentNameSource: () => metadata.nameSource,
        applyName: (name) => {
            metadata = { ...metadata, name, nameSource: TERMINAL_TAB_NAME_SOURCE };
        }
    });
    assert.equal(await syncLocalWindowsTerminalTabName(input), 'renamed');
    assert.equal(metadata.name, '许疃报告');
    assert.equal(metadata.nameSource, 'terminal-tab');

    const kept = changeTitleResultIfTerminalTab(metadata);
    assert.deepEqual(kept, { success: true, unchanged: true });
    assert.equal(changeTitleToolText(kept, 'AI 想改的标题').text, 'Session name stays the Windows Terminal tab name.');
    assert.equal(changeTitleToolText(kept, 'AI 想改的标题').isError, false);
    assert.equal(applySessionDisplayRename(client, 'AI 想改的标题'), true);
    assert.equal(metadata.name, '许疃报告');
    assert.equal(metadata.nameSource, 'terminal-tab');
    assert.equal(metadata.summary.text, '旧摘要');

    input.readTabs = async () => [{ name: '手机遥控', text: '前面的字\n列出这个文件夹里有哪些文件\n后面' }];
    assert.equal(await syncLocalWindowsTerminalTabName(input), 'renamed');
    assert.equal(metadata.name, '手机遥控');
    assert.equal(metadata.nameSource, 'terminal-tab');

    let plain = { path: '/tmp', host: 'local', name: '还不是标签名' };
    assert.equal(applySessionDisplayRename({
        updateMetadata(handler) { plain = handler(plain); }
    }, '普通改名'), true);
    assert.equal(plain.name, '普通改名');
    assert.equal(changeTitleToolText({ success: true }, '普通改名').text, 'Successfully changed chat title to: "普通改名"');
});

test('linux, remote mode, a short prompt, and a phone inject do not read tabs', async () => {
    for (const overrides of [
        { platform: 'linux' },
        { mode: 'remote' },
        { prompt: '你好' },
        { isPhoneInject: () => true }
    ]) {
        const { input, calls } = harness(overrides);
        assert.equal(await syncLocalWindowsTerminalTabName(input), 'skipped');
        assert.equal(calls.read, 0);
        assert.deepEqual(calls.apply, []);
    }
});

test('unreadable tabs and no Windows Terminal window keep the old name', async () => {
    const failed = harness({ readTabs: async () => null });
    assert.equal(await syncLocalWindowsTerminalTabName(failed.input), 'kept');
    assert.deepEqual(failed.calls.apply, []);
    const empty = harness({ readTabs: async () => [] });
    assert.equal(await syncLocalWindowsTerminalTabName(empty.input), 'kept');
    assert.deepEqual(empty.calls.apply, []);
});

test('a reader that throws does not rename and does not reject', async () => {
    const { input, calls } = harness({ readTabs: async () => { throw new Error('uia down'); } });
    assert.equal(await syncLocalWindowsTerminalTabName(input), 'kept');
    assert.deepEqual(calls.apply, []);
});

test('tab reader stays off on other platforms and treats timeout or bad json as unreadable', async () => {
    let ran = false;
    assert.equal(await readSelectedWindowsTerminalTabs({ platform: 'darwin', run: async () => { ran = true; return { stdout: '[]', timedOut: false, exitCode: 0 }; } }), null);
    assert.equal(ran, false);
    assert.equal(await readSelectedWindowsTerminalTabs({ platform: 'win32', run: async () => ({ stdout: '[]', timedOut: true, exitCode: null }) }), null);
    assert.equal(await readSelectedWindowsTerminalTabs({ platform: 'win32', run: async () => ({ stdout: 'not-json', timedOut: false, exitCode: 0 }) }), null);
    assert.deepEqual(await readSelectedWindowsTerminalTabs({ platform: 'win32', run: async () => ({ stdout: '[{"name":"许疃报告","text":"abc"}]', timedOut: false, exitCode: 0 }) }), [{ name: '许疃报告', text: 'abc' }]);
    assert.equal(parseSelectedTabs('{"name":"x"}'), null);
    assert.deepEqual(parseSelectedTabs('[]'), []);
});

test('the hook starts the rename without waiting, and only on a local prompt', () => {
    const source = fs.readFileSync(path.resolve(here, '../runClaude.ts'), 'utf8');
    assert.match(source, /void syncLocalWindowsTerminalTabName\(/);
    assert.doesNotMatch(source, /await syncLocalWindowsTerminalTabName\(/);
    const hook = source.slice(source.indexOf("if (event === 'UserPromptSubmit')"));
    assert.match(hook, /localTurnStartedAt = Date\.now\(\);\s*const promptSession = currentSession;/);
    assert.match(hook, /promptSession\.client\.hasPendingHubPromptEcho\(text\)/);
    assert.match(hook, /promptSession\.client\.getMetadata\(\)\?\.name/);
    assert.match(hook, /currentNameSource: \(\) => promptSession\.client\.getMetadata\(\)\?\.nameSource/);
    assert.match(hook, /nameSource: TERMINAL_TAB_NAME_SOURCE/);
    assert.match(hook, /promptSession\.client\.updateMetadata\(/);
});

test('powershell tab script parses', async () => {
    const { spawn } = await import('node:child_process');
    const checker = "$errors = $null; $tokens = $null; $script = [Console]::In.ReadToEnd(); [void][System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors); if ($errors -and $errors.Count -gt 0) { exit 1 }; exit 0";
    const result = await new Promise((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', checker], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', (error) => resolve({ code: 1, stderr: String(error) }));
        child.on('close', (code) => resolve({ code, stderr }));
        child.stdin.end(WINDOWS_TERMINAL_TAB_SCRIPT);
    });
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
});

test('native summary fallback does not replace a tab name', async () => {
    const mod = await import('./sessionTitleFallback.ts');
    let metadata = { path: '/tmp', host: 'local', name: '许疃报告', summary: { text: '旧摘要', updatedAt: 1 } };
    mod.applySessionTitleFallback({ updateMetadata(handler) { metadata = handler(metadata); } }, 'AI 自动摘要');
    assert.equal(metadata.name, '许疃报告');
    assert.equal(metadata.summary.text, '旧摘要');
    let namedOnly = { path: '/tmp', host: 'local', name: '手机遥控' };
    mod.applySessionTitleFallback({ updateMetadata(handler) { namedOnly = handler(namedOnly); } }, '另一条自动摘要');
    assert.equal(namedOnly.name, '手机遥控');
    assert.equal(namedOnly.summary, undefined);
});
