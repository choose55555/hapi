import { afterEach, describe, expect, it } from 'bun:test'
import { RpcGateway } from './rpcGateway'

const original = process.env.HAPI_WORKBENCH_NO_SHELL
afterEach(() => {
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
    else process.env.HAPI_WORKBENCH_NO_SHELL = original
})
describe('hub command RPC restriction', () => {
    const methods = ['bash']
    for (const method of methods) {
        it(`rejects ${method} before registry/socket access`, async () => {
            process.env.HAPI_WORKBENCH_NO_SHELL = '1'
            let lookups = 0
            let forwarded = 0
            const gateway = Object.assign(Object.create(RpcGateway.prototype), {
                rpcRegistry: { getSocketIdForMethod: () => { lookups++; return 'cli' } },
                io: { of: () => ({ sockets: new Map([['cli', {
                    timeout: () => ({ emitWithAck: async () => { forwarded++; return '{"success":true}' } })
                }]]) }) }
            }) as { rpcCall: (method: string, params: unknown) => Promise<unknown> }
            await expect(gateway.rpcCall(`s:with:colon:${method}`, {})).rejects.toThrow('工作台已禁用')
            expect(lookups).toBe(0)
            expect(forwarded).toBe(0)
        })
    }
    for (const method of ['ripgrep', 'difftastic', 'git-status', 'git-diff-numstat',
        'git-diff-file', 'workspace-ripgrep', 'workspace-git-status',
        'workspace-git-diff-numstat', 'workspace-git-diff-file', 'read-file', 'list-directory']) {
        it('allows fixed read-only RPC: ' + method, async () => {
            process.env.HAPI_WORKBENCH_NO_SHELL = '1'
            let forwarded = 0
            const gateway = Object.assign(Object.create(RpcGateway.prototype), {
                rpcRegistry: { getSocketIdForMethod: () => 'cli' },
                io: { of: () => ({ sockets: new Map([['cli', {
                    timeout: () => ({ emitWithAck: async () => { forwarded++; return '{"ok":true}' } })
                }]]) }) }
            }) as { rpcCall: (method: string, params: unknown) => Promise<unknown> }
            expect(await gateway.rpcCall('s:' + method, {})).toEqual({ ok: true })
            expect(forwarded).toBe(1)
        })
    }
    for (const value of [undefined, '', '0', 'true', '01', '1']) {
        it(`forwards permitted calls with flag ${String(value)}`, async () => {
            if (value === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
            else process.env.HAPI_WORKBENCH_NO_SHELL = value
            let calls = 0
            const gateway = Object.assign(Object.create(RpcGateway.prototype), {
                rpcRegistry: { getSocketIdForMethod: () => 'cli' },
                io: { of: () => ({ sockets: new Map([['cli', {
                    timeout: () => ({ emitWithAck: async () => { calls++; return '{"ok":true}' } })
                }]]) }) }
            }) as { rpcCall: (method: string, params: unknown) => Promise<unknown> }
            const method = value === '1' ? 's:permission' : 's:bash'
            expect(await gateway.rpcCall(method, {})).toEqual({ ok: true })
            expect(calls).toBe(1)
        })
    }
})
