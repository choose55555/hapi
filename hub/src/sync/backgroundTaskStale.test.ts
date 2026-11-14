import { describe, expect, it } from 'bun:test'
import type { Session, SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'
import { DEFAULT_BACKGROUND_TASK_STALE_MS, resolveBackgroundTaskStaleMs, shouldClearStaleBackgroundTasks } from './backgroundTaskStale'

describe('stale background tasks', () => {
    const session = { backgroundTaskCount: 1, thinking: false, agentState: { requests: {} } } as Session
    it('expires only after the threshold', () => {
        expect(shouldClearStaleBackgroundTasks(session, 0, 61 * 60000, 3600000)).toBe(true)
        expect(shouldClearStaleBackgroundTasks(session, 0, 59 * 60000, 3600000)).toBe(false)
    })
    it('preserves disabled, thinking, pending and empty states', () => {
        expect(shouldClearStaleBackgroundTasks(session, 0, 99999999, 0)).toBe(false)
        expect(shouldClearStaleBackgroundTasks({ ...session, thinking: true }, 0, 99999999, 1)).toBe(false)
        expect(shouldClearStaleBackgroundTasks({ ...session, agentState: { requests: { p: { tool: 'Bash', arguments: {} } } } }, 0, 99999999, 1)).toBe(false)
        expect(shouldClearStaleBackgroundTasks({ ...session, backgroundTaskCount: 0 }, 0, 99999999, 1)).toBe(false)
    })
    it('resolves configuration', () => {
        expect(resolveBackgroundTaskStaleMs({})).toBe(DEFAULT_BACKGROUND_TASK_STALE_MS)
        expect(resolveBackgroundTaskStaleMs({ HAPI_BACKGROUND_TASK_STALE_MS: '0' })).toBe(0)
        for (const value of ['-1', 'oops', '1abc']) expect(resolveBackgroundTaskStaleMs({ HAPI_BACKGROUND_TASK_STALE_MS: value })).toBe(DEFAULT_BACKGROUND_TASK_STALE_MS)
    })
    it('clears and broadcasts without changing updatedAt, then accepts a fresh snapshot', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const publisher = { emit: (event: SyncEvent) => { events.push(event) } } as unknown as EventPublisher
        const cache = new SessionCache(store, publisher)
        const previous = process.env.HAPI_BACKGROUND_TASK_STALE_MS
        try {
            process.env.HAPI_BACKGROUND_TASK_STALE_MS = '3600000'
            const created = cache.getOrCreateSession('stale-background-test', { path: '/tmp/test', host: 'test' }, null, 'default')
            cache.setBackgroundTasks(created.id, [{ id: 'task-1', type: 'command', description: 'test' }])
            const updatedAt = cache.getSession(created.id)!.updatedAt
            const later = Date.now() + 61 * 60000
            cache.handleSessionAlive({ sid: created.id, time: later })
            events.length = 0
            cache.expireInactive(later)
            expect(cache.getSession(created.id)!.backgroundTaskCount).toBe(0)
            expect(cache.getSession(created.id)!.backgroundTasks).toEqual([])
            expect(cache.getSession(created.id)!.updatedAt).toBe(updatedAt)
            expect(events).toContainEqual({ type: 'session-updated', sessionId: created.id, data: { backgroundTaskCount: 0, backgroundTasks: [] } })
            cache.setBackgroundTasks(created.id, [{ id: 'task-2', type: 'command', description: 'fresh' }])
            expect(cache.getSession(created.id)!.backgroundTaskCount).toBe(1)
        } finally {
            if (previous === undefined) delete process.env.HAPI_BACKGROUND_TASK_STALE_MS
            else process.env.HAPI_BACKGROUND_TASK_STALE_MS = previous
            store.close()
        }
    })
})
