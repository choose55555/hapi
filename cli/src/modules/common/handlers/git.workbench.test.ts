import { afterEach, describe, expect, it, vi } from 'vitest'
const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('child_process', () => ({
    execFile: exec.mockImplementation((_file, _args, _options, callback) =>
        callback(null, { stdout: '', stderr: '' }))
}))
import { runGitCommand } from './git'
const original = process.env.HAPI_WORKBENCH_NO_SHELL
afterEach(() => {
    exec.mockClear()
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
    else process.env.HAPI_WORKBENCH_NO_SHELL = original
})
describe('actual Git execution argv', () => {
    it('protects numstat and keeps status free of diff-only options', async () => {
        process.env.HAPI_WORKBENCH_NO_SHELL = '1'
        await runGitCommand(['diff', '--numstat'], '/unused')
        expect(exec.mock.calls[0][1]).toEqual([
            '-c', 'core.fsmonitor=', 'diff', '--no-ext-diff', '--no-textconv', '--numstat'
        ])
        await runGitCommand(['status'], '/unused')
        expect(exec.mock.calls[1][1]).toEqual(['-c', 'core.fsmonitor=', 'status'])
    })
    it('passes the original argv when disabled', async () => {
        delete process.env.HAPI_WORKBENCH_NO_SHELL
        const args = ['diff', '--numstat']
        await runGitCommand(args, '/unused')
        expect(exec.mock.calls[0][1]).toBe(args)
    })
})

