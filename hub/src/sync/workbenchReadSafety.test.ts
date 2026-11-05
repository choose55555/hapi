import { RpcGateway } from './rpcGateway'
import { afterEach, describe, expect, it } from 'bun:test'
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

describe('hub preprocessor dispatch boundary', () => {
    for (const method of ['ripgrep', 'workspace-ripgrep']) {
        it('rejects before lookup and preserves params when off: ' + method, async () => {
            let lookups = 0
            let forwarded: unknown
            const gateway = Object.assign(Object.create(RpcGateway.prototype), {
                rpcRegistry: { getSocketIdForMethod: () => { lookups++; return 'cli' } },
                io: { of: () => ({ sockets: new Map([['cli', {
                    timeout: () => ({ emitWithAck: async (_event: string, request: unknown) => {
                        forwarded = request
                        return '{"ok":true}'
                    } })
                }]]) }) }
            }) as { rpcCall: (method: string, params: unknown) => Promise<unknown> }
            const params = { args: ['--pre=program'] }
            process.env.HAPI_WORKBENCH_NO_SHELL = '1'
            await expect(gateway.rpcCall('s:with:colon:' + method, params))
                .rejects.toThrow('不允许搜索时启动外部预处理程序')
            expect(lookups).toBe(0)
            delete process.env.HAPI_WORKBENCH_NO_SHELL
            await gateway.rpcCall('s:with:colon:' + method, params)
            expect(forwarded).toEqual({
                method: 's:with:colon:' + method, params: JSON.stringify(params)
            })
        })
    }
})


