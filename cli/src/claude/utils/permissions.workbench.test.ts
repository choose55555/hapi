import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalPermissionBridge } from './localPermissionBridge'
import { PermissionHandler } from './permissionHandler'
import type { AgentState } from '@/api/types'
import type { Session } from '../session'
import type { PermissionHandlerClient } from '@/modules/common/permission/BasePermissionHandler'

afterEach(() => vi.unstubAllEnvs())
function clientHarness() {
    let state: AgentState = { requests: {}, completedRequests: {} }
    let reply: (value: unknown) => unknown = () => {}
    const client: PermissionHandlerClient = {
        updateAgentState: fn => { state = fn(state) },
        rpcHandlerManager: { registerHandler: <TRequest, TResponse>(_method: string, fn: (data: TRequest) => TResponse | Promise<TResponse>) => {
            reply = value => fn(value as TRequest)
        } }
    }
    return { client, reply: (value: unknown) => reply(value), state: () => state }
}
describe('workbench permission reply paths', () => {
    it('rejects local mode switch before consuming a pending request', async () => {
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', '1')
        const h = clientHarness(), bridge = new LocalPermissionBridge(h.client)
        bridge.start('native')
        const hook = {
            hook_event_name: 'PermissionRequest' as const, session_id: 'native', prompt_id: 'p',
            tool_name: 'Bash', tool_input: { command: 'echo hello' }
        }
        bridge.onHook({ ...hook, hook_event_name: 'PreToolUse', tool_use_id: 't' })
        const pending = bridge.request(hook, new AbortController().signal)
        const id = Object.keys(h.state().requests ?? {})[0]
        expect(id).toBeDefined()
        expect(() => h.reply({ id, approved: true, mode: 'bypassPermissions' })).toThrow('手机端不能切换')
        expect(h.state().requests?.[id]).toBeDefined()
        h.reply({ id, approved: false })
        expect(await pending).toMatchObject({ behavior: 'deny' })
        bridge.stop()
    })
    it('rejects SDK reply mode before changing session or losing the request', async () => {
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', '1')
        const h = clientHarness()
        const setMode = vi.fn()
        const session = {
            client: h.client, getPermissionMode: () => 'default', setPermissionMode: setMode,
            queue: { unshift: vi.fn() }
        } as unknown as Session
        const handler = new PermissionHandler(session)
        handler.onMessage({
            type: 'assistant', message: { role: 'assistant',
                content: [{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: { questions: [] } }]
            }
        } as never)
        const pending = handler.handleToolCall('AskUserQuestion', { questions: [] },
            { permissionMode: 'default' }, { signal: new AbortController().signal })
        await expect(h.reply({ id: 't', approved: true, mode: 'bypassPermissions' })).rejects.toThrow('手机端不能切换')
        expect(h.state().requests?.t).toBeDefined()
        expect(setMode).not.toHaveBeenCalled()
        await h.reply({ id: 't', approved: false })
        await pending
    })
})
