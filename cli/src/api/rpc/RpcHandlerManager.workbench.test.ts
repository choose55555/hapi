import { afterEach, describe, expect, it } from 'vitest'
import { RpcHandlerManager } from './RpcHandlerManager'
import { registerBashHandlers } from '@/modules/common/handlers/bash'

const original = process.env.HAPI_WORKBENCH_NO_SHELL
afterEach(() => {
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
    else process.env.HAPI_WORKBENCH_NO_SHELL = original
})

describe('workbench browser command RPC boundary', () => {
    it('rejects direct bash handler calls before reading untrusted data', async () => {
        process.env.HAPI_WORKBENCH_NO_SHELL = '1'
        let handler: ((data: unknown) => unknown) | undefined
        const manager = {
            registerHandler: (_method: string, fn: (data: unknown) => unknown) => { handler = fn }
        } as unknown as RpcHandlerManager
        registerBashHandlers(manager, '/unused')
        const result = await handler!(undefined) as { success: boolean; error: string }
        expect(result.success).toBe(false)
        expect(result.error).toContain('工作台已禁用')
    })
    const blocked = ['bash']
    for (const method of blocked) {
        it(`rejects ${method} before parsing or invoking its handler`, async () => {
            process.env.HAPI_WORKBENCH_NO_SHELL = '1'
            const manager = new RpcHandlerManager({ scopePrefix: 'session:with:colons' })
            let calls = 0
            manager.registerHandler(method, () => { calls++; return { success: true } })
            const result = JSON.parse(await manager.handleRequest({
                method: `session:with:colons:${method}`, params: '{invalid'
            }))
            expect(result.success).toBe(false)
            expect(result.error).toContain('工作台已禁用')
            expect(calls).toBe(0)
        })
    }
    for (const method of ['ripgrep', 'difftastic', 'git-status', 'git-diff-numstat',
        'git-diff-file', 'workspace-ripgrep', 'workspace-git-status',
        'workspace-git-diff-numstat', 'workspace-git-diff-file', 'read-file', 'list-directory']) {
        it('keeps fixed read-only RPC available: ' + method, async () => {
            process.env.HAPI_WORKBENCH_NO_SHELL = '1'
            const manager = new RpcHandlerManager({ scopePrefix: 's' })
            manager.registerHandler(method, () => ({ ok: true }))
            expect(JSON.parse(await manager.handleRequest({ method: 's:' + method, params: '{}' }))).toEqual({ ok: true })
        })
    }
    for (const value of [undefined, '', '0', 'true', '01']) {
        it(`preserves upstream dispatch for ${String(value)}`, async () => {
            if (value === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
            else process.env.HAPI_WORKBENCH_NO_SHELL = value
            const manager = new RpcHandlerManager({ scopePrefix: 's' })
            manager.registerHandler('bash', (params) => ({ success: true, params }))
            expect(JSON.parse(await manager.handleRequest({
                method: 's:bash', params: '{"command":"placeholder"}'
            }))).toEqual({ success: true, params: { command: 'placeholder' } })
        })
    }
    it('keeps ordinary session control RPCs available', async () => {
        process.env.HAPI_WORKBENCH_NO_SHELL = '1'
        const manager = new RpcHandlerManager({ scopePrefix: 's' })
        manager.registerHandler('permission', () => ({ allowed: true }))
        expect(JSON.parse(await manager.handleRequest({ method: 's:permission', params: '{}' })))
            .toEqual({ allowed: true })
    })
})
