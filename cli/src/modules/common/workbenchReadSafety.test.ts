import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { afterEach, describe, expect, it } from 'vitest'
import { assertWorkbenchReadRpcAllowed, workbenchGitArgs } from './workbenchShell'
const original = process.env.HAPI_WORKBENCH_NO_SHELL
afterEach(() => {
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
    else process.env.HAPI_WORKBENCH_NO_SHELL = original
})
describe('restricted read utility arguments', () => {
    for (const method of ['ripgrep', 'workspace-ripgrep']) {
        for (const arg of ['--pre', '--pre=program', '--pre-glob', '--pre-glob=*.txt']) {
            it(method + ' rejects ' + arg, () => {
                process.env.HAPI_WORKBENCH_NO_SHELL = '1'
                expect(() => assertWorkbenchReadRpcAllowed(method, { args: [arg] }))
                    .toThrow('不允许搜索时启动外部预处理程序')
            })
        }
    }
    for (const method of ['ripgrep', 'workspace-ripgrep']) {
        it(method + ' ignores ripgrep config files when restricted', () => {
            process.env.HAPI_WORKBENCH_NO_SHELL = '1'
            const params = { args: ['needle', 'src'] }
            assertWorkbenchReadRpcAllowed(method, params)
            expect(params.args).toEqual(['--no-config', 'needle', 'src'])
            assertWorkbenchReadRpcAllowed(method, params)
            expect(params.args).toEqual(['--no-config', 'needle', 'src'])
        })
    }
    it('leaves ripgrep arguments untouched when not restricted', () => {
        delete process.env.HAPI_WORKBENCH_NO_SHELL
        const params = { args: ['needle'] }
        assertWorkbenchReadRpcAllowed('ripgrep', params)
        expect(params.args).toEqual(['needle'])
    })
    it('adds all three protections to diff, including numstat and literal paths', () => {
        process.env.HAPI_WORKBENCH_NO_SHELL = '1'
        for (const args of [['diff', '--numstat'], ['--literal-pathspecs', 'diff', '--', 'file']]) {
            const safe = workbenchGitArgs(args)
            expect(safe.slice(0, 2)).toEqual(['-c', 'core.fsmonitor='])
            expect(safe.slice(safe.indexOf('diff') + 1, safe.indexOf('diff') + 3))
                .toEqual(['--no-ext-diff', '--no-textconv'])
        }
    })
    it('adds only fsmonitor protection to status', () => {
        process.env.HAPI_WORKBENCH_NO_SHELL = '1'
        expect(workbenchGitArgs(['status', '--porcelain=v2']))
            .toEqual(['-c', 'core.fsmonitor=', 'status', '--porcelain=v2'])
    })
    for (const flag of [undefined, '', '0', 'true', '01']) {
        it('preserves original arguments for flag ' + String(flag), () => {
            if (flag === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
            else process.env.HAPI_WORKBENCH_NO_SHELL = flag
            const args = ['diff', '--numstat']
            expect(workbenchGitArgs(args)).toBe(args)
            expect(() => assertWorkbenchReadRpcAllowed('ripgrep', { args: ['--pre=program'] }))
                .not.toThrow()
        })
    }
})

describe('CLI preprocessor dispatch boundary', () => {
    for (const method of ['ripgrep', 'workspace-ripgrep']) {
        it('rejects before the handler and passes original params when off: ' + method, async () => {
            const manager = new RpcHandlerManager({ scopePrefix: 's:with:colon', logger: () => {} })
            let calls = 0
            const params = { args: ['--pre=program'] }
            manager.registerHandler(method, data => { calls++; return data })
            process.env.HAPI_WORKBENCH_NO_SHELL = '1'
            const result = JSON.parse(await manager.handleRequest({
                method: 's:with:colon:' + method, params: JSON.stringify(params)
            }))
            expect(result.error).toContain('不允许搜索时启动外部预处理程序')
            expect(calls).toBe(0)
            delete process.env.HAPI_WORKBENCH_NO_SHELL
            expect(JSON.parse(await manager.handleRequest({
                method: 's:with:colon:' + method, params: JSON.stringify(params)
            }))).toEqual(params)
            expect(calls).toBe(1)
        })
    }
})


