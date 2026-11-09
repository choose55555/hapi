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
