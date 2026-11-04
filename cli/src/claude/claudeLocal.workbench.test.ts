import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
const harness = vi.hoisted(() => ({ spawn: vi.fn(async (_opts: unknown) => {}) }))
vi.mock('@/utils/spawnWithTerminalGuard', () => ({ spawnWithTerminalGuard: harness.spawn }))
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }))
vi.mock('./utils/mcpConfig', () => ({ appendMcpConfigArg: () => undefined }))
vi.mock('./sdk/utils', () => ({ getDefaultClaudeCodePath: () => '/usr/bin/claude' }))
import { claudeLocal } from './claudeLocal'
const dirs: string[] = []
afterEach(() => {
    vi.unstubAllEnvs(); harness.spawn.mockReset()
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})
describe('workbench local settings lifecycle', () => {
    it.each(['success', 'reject', 'exit'])('retains copy until spawn finishes and cleans it, outcome=%s', async outcome => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '1')
        const dir = mkdtempSync(join(tmpdir(), 'hapi-local-test-'))
        dirs.push(dir)
        const user = join(dir, 'user.json'), hooks = join(dir, 'hooks.json')
        writeFileSync(user, '{"permissions":{"defaultMode":"auto"},"hooks":{"Stop":[]}}')
        writeFileSync(hooks, '{"hooks":{"Stop":[{"hooks":[]}]}}')
        const exitListeners = process.listenerCount('exit')
        const originalListeners = new Set(process.listeners('exit'))
        let copy = ''
        harness.spawn.mockImplementationOnce(async (opts: unknown) => {
            const args = (opts as { args: string[] }).args
            expect(args.filter(arg => arg === '--settings')).toHaveLength(1)
            copy = args[args.indexOf('--settings') + 1]
            expect(process.listenerCount('exit')).toBe(exitListeners + 1)
            expect(JSON.parse(readFileSync(copy, 'utf8')).permissions.defaultMode).toBe('auto')
            if (outcome === 'exit') {
                // Invoke only this launch's exit handler, without exiting the test runner.
                const onExit = process.listeners('exit').find(listener => !originalListeners.has(listener))!
                expect(onExit).toBeTypeOf('function')
                onExit(0)
                expect(existsSync(dirname(copy))).toBe(false)
            }
            if (outcome === 'reject') throw new Error('fake spawn failed')
        })
        const promise = claudeLocal({
            abort: new AbortController().signal, sessionId: null, path: dir,
            claudeArgs: ['--settings', user], hookSettingsPath: hooks
        })
        if (outcome === 'reject') await expect(promise).rejects.toThrow('fake spawn failed')
        else await promise
        expect(copy).not.toBe('')
        expect(existsSync(copy)).toBe(false)
        expect(existsSync(dirname(copy))).toBe(false)
        expect(process.listenerCount('exit')).toBe(exitListeners)
        expect(readFileSync(user, 'utf8')).toBe('{"permissions":{"defaultMode":"auto"},"hooks":{"Stop":[]}}')
    })
    it('refuses malformed user settings without spawning', async () => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '1')
        await expect(claudeLocal({
            abort: new AbortController().signal, sessionId: null, path: process.cwd(),
            claudeArgs: ['--settings={"hooks":false}'], hookSettingsPath: 'not-read.json'
        })).rejects.toThrow()
        expect(harness.spawn).not.toHaveBeenCalled()
    })
})
