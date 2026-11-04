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
