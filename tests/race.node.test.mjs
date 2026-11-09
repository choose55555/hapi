import assert from 'node:assert/strict';
import { test } from 'node:test';
// Reproducible RED against the unchanged live-version source snapshot, not hapi.exe.
const { syncLocalWindowsTerminalTabName } = await import(process.env.T50_TEST_BASELINE === 'T41'
    ? '../../T41候选/repo/cli/src/claude/utils/windowsTerminalTabName.ts'
    : '../repo/cli/src/claude/utils/windowsTerminalTabName.ts');

test('00:24 A submits then selected B contains the same sentence; late B result must not rename A', async () => {
    const prompt = '11月17日前禁止使用kimi：请认真看这张截图';
    for (const oldName of ['地震勘探软件', '工作台优化', 'hapi测试']) {
        let now = 0;
        let selected = 'A';
        let release;
        const read = new Promise((resolve) => { release = resolve; });
        const writes = [];
        const pending = syncLocalWindowsTerminalTabName({
            platform: 'win32', mode: 'local', prompt,
            submittedAt: 0, now: () => now,
            isPhoneInject: () => false,
            readTabs: () => read,
            currentName: () => oldName,
            currentNameSource: () => 'terminal-tab',
            applyName: (name) => writes.push(name)
        });
        selected = 'B';
        now = 3026;
        assert.equal(selected, 'B');
        release([{ name: '祁南', text: `❯ ${prompt}\n● 收到，我先核查。\n❯ ` }]);
        assert.equal(await pending, 'kept');
        assert.deepEqual(writes, []);
    }
});

// Synthetic UIA shape only: no real conversation or terminal access.
const layoutPrompt = '请检查离线样例中的标签同步结果';
const noReplyLayout = `历史输出\n❯ ${layoutPrompt}\n\n❯ \n────────────────────────\n[common] project:offline-sample ⏵⏵ bypass permissions on`;

test('realistic layout without a reply and with bottom input plus status renames an empty name', async () => {
    const writes = [];
    assert.equal(await syncLocalWindowsTerminalTabName({
        platform: 'win32', mode: 'local', prompt: layoutPrompt,
        submittedAt: 0, now: () => 600,
        isPhoneInject: () => false,
        readTabs: async () => [{ name: '离线样例', text: noReplyLayout }],
        currentName: () => undefined,
        applyName: (name) => writes.push(name)
    }), 'renamed');
    assert.deepEqual(writes, ['离线样例']);
});

test('realistic layout without a reply keeps an existing terminal name once then renames on confirmation', async () => {
    const { createTabNameSyncState } = await import('../repo/cli/src/claude/utils/windowsTerminalTabName.ts');
    let name = '原标签';
    const writes = [];
    const input = {
        platform: 'win32', mode: 'local', prompt: layoutPrompt,
        submittedAt: 0, now: () => 600, state: createTabNameSyncState(),
        isPhoneInject: () => false,
        readTabs: async () => [{ name: '离线样例', text: noReplyLayout }],
        currentName: () => name, currentNameSource: () => 'terminal-tab',
        applyName: (value) => { name = value; writes.push(value); }
    };
    assert.equal(await syncLocalWindowsTerminalTabName(input), 'kept');
    assert.equal(name, '原标签');
    assert.deepEqual(writes, []);
    assert.equal(await syncLocalWindowsTerminalTabName(input), 'renamed');
    assert.deepEqual(writes, ['离线样例']);
});

test('fresh wrong-window result keeps an existing terminal-tab name on its first read', async () => {
    const writes = [];
    assert.equal(await syncLocalWindowsTerminalTabName({
        platform: 'win32', mode: 'local', prompt: layoutPrompt,
        submittedAt: 0, now: () => 1000,
        isPhoneInject: () => false,
        readTabs: async () => [{ name: '别窗标签', text: `❯ ${layoutPrompt}\n● 合成回复\n❯ ` }],
        currentName: () => '本窗标签', currentNameSource: () => 'terminal-tab',
        applyName: (name) => writes.push(name)
    }), 'kept');
    assert.deepEqual(writes, []);
});
