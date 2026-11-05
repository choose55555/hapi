import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn
}))
vi.mock('@/utils/bunRuntime', () => ({ withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env }))
vi.mock('@/utils/process', () => ({ killProcessByChildProcess: async () => {} }))
vi.mock('../utils/mcpConfig', () => ({ appendMcpConfigArg: () => null }))
const dirs: string[] = []
afterEach(() => {
    vi.unstubAllEnvs(); vi.clearAllMocks()
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})
describe('workbench SDK settings lifecycle', () => {
    it.each(['1', '0', 'true'])('passes child-only environment through shared SDK spawn, switch=%s', async flag => {
        vi.stubEnv('HAPI_WORKBENCH_CHILD_ENV', flag)
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '0')
        for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) vi.stubEnv(key, undefined)
        vi.stubEnv('HAPI_WORKBENCH_CHILD_HTTPS_PROXY', 'http://127.0.0.1:17898')
        vi.stubEnv('CLI_API_TOKEN', 'fake-hapi-token')
        const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
        })
        mocks.spawn.mockReturnValueOnce(child)
        const { query } = await import('./query')
        const stream = query({ prompt: 'hello', env: { HTTPS_PROXY: 'option-original', WORKBENCH_TEST_CHILD: 'child-only' },
            options: { pathToClaudeCodeExecutable: 'claude' } })
        const env = mocks.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv
        expect(env.HTTPS_PROXY).toBe(flag === '1' ? 'http://127.0.0.1:17898' : undefined)
        expect(env.WORKBENCH_TEST_CHILD).toBe(flag === '1' ? 'child-only' : undefined)
        expect(process.env.WORKBENCH_TEST_CHILD).toBeUndefined()
        expect(env.CLI_API_TOKEN).toBe(flag === '1' ? undefined : 'fake-hapi-token')
        expect(env.HAPI_WORKBENCH_CHILD_HTTPS_PROXY).toBe(flag === '1' ? undefined : 'http://127.0.0.1:17898')
        expect(env.HAPI_WORKBENCH_CHILD_ENV).toBe(flag === '1' ? undefined : flag)
        expect(process.env.HTTPS_PROXY).toBeUndefined()
        expect(process.env.CLI_API_TOKEN).toBe('fake-hapi-token')
        child.stdout.end()
        child.emit('close', 0)
        await stream.next()
    })

    it('serializes SDK continue together with preserved remote startup arguments', async () => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '0')
        const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
        })
        mocks.spawn.mockReturnValueOnce(child)
        const { query } = await import('./query')
        const additionalArgs = ['--strict-mcp-config', '--fallback-model=backup', '--session-id=11111111-1111-4111-8111-111111111111']
        const stream = query({ prompt: 'hello', options: {
            pathToClaudeCodeExecutable: 'claude', continue: true, additionalArgs
        } })
        const args = mocks.spawn.mock.calls[0][1] as string[]
        expect(args.filter(arg => arg === '--continue')).toHaveLength(1)
        expect(args.slice(args.indexOf('--continue') + 1, args.indexOf('--continue') + 1 + additionalArgs.length)).toEqual(additionalArgs)
        child.stdout.end()
        child.emit('close', 0)
        await stream.next()
    })

    it.each(['close', 'error', 'throw', 'exit'])('cleans the private copy on %s', async event => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '1')
        const dir = mkdtempSync(join(tmpdir(), 'hapi-query-test-'))
        dirs.push(dir)
        const hooks = join(dir, 'hooks.json')
        writeFileSync(hooks, '{"hooks":{"SessionStart":[]}}')
        const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
        })
        let copy = ''
        const originalListeners = new Set(process.listeners('exit'))
        mocks.spawn.mockImplementationOnce((_command: string, args: string[]) => {
            copy = args[args.indexOf('--settings') + 1]
            expect(args.filter(arg => arg === '--settings')).toHaveLength(1)
            expect(JSON.parse(readFileSync(copy, 'utf8')).permissions.defaultMode).toBe('auto')
            if (event === 'throw') throw new Error('sync spawn failure')
            return child
        })
        const { query } = await import('./query')
        const launch = () => query({ prompt: 'hello', options: {
            pathToClaudeCodeExecutable: 'claude', cwd: dir,
            additionalArgs: ['--settings={"permissions":{"defaultMode":"auto"}}'], settingsPath: hooks
        } })
        if (event === 'throw') {
            expect(launch).toThrow('sync spawn failure')
        } else {
            const stream = launch()
            if (event === 'exit') {
                const onExit = process.listeners('exit').find(listener => !originalListeners.has(listener))!
                expect(onExit).toBeTypeOf('function')
                onExit(0)
                expect(existsSync(dirname(copy))).toBe(false)
            }
            child.stdout.end()
            if (event === 'error') {
                const rejected = expect(stream.next()).rejects.toThrow('fake failure')
                child.emit('error', new Error('fake failure'))
                await rejected
            } else {
                child.emit('close', 0)
                await stream.next()
            }
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        expect(copy).not.toBe('')
        expect(existsSync(copy)).toBe(false)
        expect(existsSync(dirname(copy))).toBe(false)
    })
})
