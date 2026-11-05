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
    it.each([
        ['--session-id', 'startup-session'],
        ['--session-id=startup-session']
    ])('preserves startup session ID without an existing session: %j', async (...sessionArgs) => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '0')
        const claudeArgs = ['--verbose', ...sessionArgs, '--model', 'startup-model']
        const originalArgs = [...claudeArgs]
        await claudeLocal({
            abort: new AbortController().signal, sessionId: null, path: process.cwd(),
            claudeArgs, hookSettingsPath: 'not-read.json'
        })
        const args = (harness.spawn.mock.calls[0][0] as { args: string[] }).args
        expect(args).not.toContain('--resume')
        expect(args.slice(args.indexOf('--verbose'), args.indexOf('--verbose') + claudeArgs.length)).toEqual(originalArgs)
        expect(claudeArgs).toEqual(originalArgs)
    })

    it.each([
        ['--session-id', 'startup-session'],
        ['--session-id=startup-session'],
        ['--session-id', 'first-session', '--session-id=second-session']
    ])('removes startup session IDs only when adding automatic resume: %j', async (...sessionArgs) => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '0')
        const claudeArgs = ['--verbose', ...sessionArgs, '--model', 'startup-model', '--session-id-file', 'keep.json']
        const originalArgs = [...claudeArgs]
        const result = await claudeLocal({
            abort: new AbortController().signal, sessionId: 'existing-session', path: process.cwd(),
            claudeArgs, model: 'tracked-model', hookSettingsPath: 'not-read.json'
        })
        const args = (harness.spawn.mock.calls[0][0] as { args: string[] }).args
        expect(args.slice(0, 2)).toEqual(['--resume', 'existing-session'])
        expect(args.filter(arg => arg === '--resume')).toHaveLength(1)
        expect(args.some(arg => arg === '--session-id' || arg.startsWith('--session-id='))).toBe(false)
        for (const value of ['startup-session', 'first-session', 'second-session', 'startup-model']) {
            expect(args).not.toContain(value)
        }
        expect(args.slice(args.indexOf('--verbose'), args.indexOf('--verbose') + 5)).toEqual([
            '--verbose', '--session-id-file', 'keep.json', '--model', 'tracked-model'
        ])
        expect(claudeArgs).toEqual(originalArgs)
        expect(result).toBe('existing-session')
    })

    it.each([
        ['--resume', 'user-session', '--session-id', 'fork-session', '--fork-session'],
        ['--continue', '--session-id=fork-session', '--fork-session']
    ])('preserves explicit user session controls: %j', async (...claudeArgs) => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '0')
        const originalArgs = [...claudeArgs]
        await claudeLocal({
            abort: new AbortController().signal, sessionId: 'existing-session', path: process.cwd(),
            claudeArgs, hookSettingsPath: 'not-read.json'
        })
        const args = (harness.spawn.mock.calls[0][0] as { args: string[] }).args
        expect(args).not.toContain('existing-session')
        expect(args.slice(args.indexOf(claudeArgs[0]), args.indexOf(claudeArgs[0]) + claudeArgs.length)).toEqual(originalArgs)
        expect(claudeArgs).toEqual(originalArgs)
    })

    it.each(['1', '0', 'true'])('passes child-only environment through local spawn, switch=%s', async flag => {
        vi.stubEnv('HAPI_WORKBENCH_CHILD_ENV', flag)
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '0')
        for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) vi.stubEnv(key, undefined)
        vi.stubEnv('HAPI_WORKBENCH_CHILD_HTTPS_PROXY', 'http://127.0.0.1:17898')
        vi.stubEnv('CLI_API_TOKEN', 'fake-hapi-token')
        await claudeLocal({ abort: new AbortController().signal, sessionId: null, path: process.cwd(),
            claudeEnvVars: { HTTPS_PROXY: 'child-option-original' } } as unknown as Parameters<typeof claudeLocal>[0])
        const env = (harness.spawn.mock.calls[0][0] as { env: NodeJS.ProcessEnv }).env
        expect(env.HTTPS_PROXY).toBe(flag === '1' ? 'http://127.0.0.1:17898' : 'child-option-original')
        expect(env.CLI_API_TOKEN).toBe(flag === '1' ? undefined : 'fake-hapi-token')
        expect(env.HAPI_WORKBENCH_CHILD_HTTPS_PROXY).toBe(flag === '1' ? undefined : 'http://127.0.0.1:17898')
        expect(env.HAPI_WORKBENCH_CHILD_ENV).toBe(flag === '1' ? undefined : flag)
        expect(process.env.HTTPS_PROXY).toBeUndefined()
        expect(process.env.CLI_API_TOKEN).toBe('fake-hapi-token')
    })

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
