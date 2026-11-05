import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createMachinesRoutes } from './machines'
import { createSessionsRoutes } from './sessions'
import { RpcGateway } from '../../sync/rpcGateway'
import { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { WORKBENCH_NO_SPAWN_MESSAGE, PERMISSION_LOCK_MESSAGE } from '../../sync/workbench'

const original = process.env.HAPI_WORKBENCH_NO_SPAWN
const originalPreserve = process.env.HAPI_WORKBENCH_PRESERVE_REMOTE
afterEach(() => {
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_SPAWN
    else process.env.HAPI_WORKBENCH_NO_SPAWN = original
    if (originalPreserve === undefined) delete process.env.HAPI_WORKBENCH_PRESERVE_REMOTE
    else process.env.HAPI_WORKBENCH_PRESERVE_REMOTE = originalPreserve
})
describe('workbench no spawn', () => {
    it('returns 403 before resolving a runner, parsing a body, or changing session state', async () => {
        process.env.HAPI_WORKBENCH_NO_SPAWN = '1'
        const app = new Hono<WebAppEnv>()
        const engine = () => { throw new Error('must not access engine') }
        app.route('/api', createMachinesRoutes(engine))
        app.route('/api', createSessionsRoutes(engine))
        for (const path of [
            '/api/machines/m/spawn', '/api/machines/m/restart-runner', '/api/sessions/s/fork',
            '/api/sessions/s/resume', '/api/sessions/s/reopen',
            '/api/sessions/s/clear', '/api/sessions/s/migrate-to-acp',
            '/api/sessions/s/codex/plan/implement'
        ]) {
            const response = await app.request(path, { method: 'POST', body: '{' })
            expect(response.status).toBe(403)
            expect(await response.json()).toEqual({ error: WORKBENCH_NO_SPAWN_MESSAGE, code: 'workbench_no_spawn' })
        }
    })
    it.each(['0', 'true', undefined])('disabled route keeps upstream disconnected response: %s', async value => {
        if (value === undefined) delete process.env.HAPI_WORKBENCH_NO_SPAWN
        else process.env.HAPI_WORKBENCH_NO_SPAWN = value
        const app = new Hono<WebAppEnv>()
        app.route('/api', createMachinesRoutes(() => null))
        expect((await app.request('/api/machines/m/spawn', { method: 'POST' })).status).toBe(503)
    })
    it('blocks engine preallocation and direct RPC dispatch without a runner', async () => {
        process.env.HAPI_WORKBENCH_NO_SPAWN = '1'
        // These empty receivers fail if the guard accesses state or RPC before refusing.
        await expect(SyncEngine.prototype.spawnSession.call({} as SyncEngine, 'm', '/tmp')).rejects.toMatchObject({ message: WORKBENCH_NO_SPAWN_MESSAGE })
        await expect(SyncEngine.prototype.restartMachineRunner.call({} as SyncEngine, 'm', 'n')).rejects.toMatchObject({ message: WORKBENCH_NO_SPAWN_MESSAGE })
        await expect(RpcGateway.prototype.spawnSession.call({} as RpcGateway, 'm', '/tmp')).rejects.toMatchObject({ message: WORKBENCH_NO_SPAWN_MESSAGE })
        await expect(RpcGateway.prototype.forkConversation.call({} as RpcGateway, 's', {})).rejects.toMatchObject({ message: WORKBENCH_NO_SPAWN_MESSAGE })
        await expect(SyncEngine.prototype.sendMessage.call({} as SyncEngine, 's', { text: ' /clear ' })).rejects.toMatchObject({ message: WORKBENCH_NO_SPAWN_MESSAGE })
    })
    it('rejects POST /api/machines/:id/spawn with the full reason before touching the engine', async () => {
        process.env.HAPI_WORKBENCH_NO_SPAWN = '1'
        const app = new Hono<WebAppEnv>()
        app.route('/api', createMachinesRoutes(() => { throw new Error('must not access engine') }))
        const response = await app.request('/api/machines/peer/spawn', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ directory: '/tmp', agent: 'claude' })
        })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: WORKBENCH_NO_SPAWN_MESSAGE, code: 'workbench_no_spawn' })
    })
    it('still sends ordinary messages to an existing session', async () => {
        process.env.HAPI_WORKBENCH_NO_SPAWN = '1'
        const sent: unknown[] = []
        const receiver = {
            historyActionsInFlight: new Set(),
            sessionCache: {
                getSession: () => ({ thinking: true }),
                markMessageQueued: () => {}, recordSessionActivity: () => {}
            },
            messageService: { sendMessage: async (...args: unknown[]) => {
                sent.push(args)
                return { actualSessionId: 's', createdAt: 1 }
            } }
        } as unknown as SyncEngine
        await SyncEngine.prototype.sendMessage.call(receiver, 's', { text: 'hello' })
        expect(sent).toEqual([['s', { text: 'hello' }]])
    })
    it('blocks inactive permission changes but permits same-mode model updates', async () => {
        process.env.HAPI_WORKBENCH_NO_SPAWN = '0'
        process.env.HAPI_WORKBENCH_PRESERVE_REMOTE = '1'
        const applied: unknown[] = []
        const receiver = { sessionCache: {
            getSession: () => ({ active: false, permissionMode: 'default' }),
            applySessionConfig: (...args: unknown[]) => applied.push(args)
        } } as unknown as SyncEngine
        await expect(SyncEngine.prototype.applySessionConfig.call(receiver, 's', { permissionMode: 'plan' })).rejects.toMatchObject({ message: PERMISSION_LOCK_MESSAGE })
        expect(applied).toEqual([])
        const config = { permissionMode: 'default' as const, model: 'test-model' }
        await SyncEngine.prototype.applySessionConfig.call(receiver, 's', config)
        expect(applied).toEqual([['s', config]])
        process.env.HAPI_WORKBENCH_PRESERVE_REMOTE = '0'
        process.env.HAPI_WORKBENCH_NO_SPAWN = '1'
        await SyncEngine.prototype.applySessionConfig.call(receiver, 's', { permissionMode: 'plan' })
        expect(applied).toHaveLength(2)
    })
})
