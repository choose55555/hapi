import { describe, expect, it } from 'vitest'
import type { Session } from '@hapi/protocol/types'
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
        expect(shouldClearStaleBackgroundTasks({ ...session, agentState: { requests: { p: {} } } } as Session, 0, 99999999, 1)).toBe(false)
        expect(shouldClearStaleBackgroundTasks({ ...session, backgroundTaskCount: 0 }, 0, 99999999, 1)).toBe(false)
    })
    it('resolves configuration', () => {
        expect(resolveBackgroundTaskStaleMs({})).toBe(DEFAULT_BACKGROUND_TASK_STALE_MS)
        expect(resolveBackgroundTaskStaleMs({ HAPI_BACKGROUND_TASK_STALE_MS: '0' })).toBe(0)
        for (const value of ['-1', 'oops', '1abc']) expect(resolveBackgroundTaskStaleMs({ HAPI_BACKGROUND_TASK_STALE_MS: value })).toBe(DEFAULT_BACKGROUND_TASK_STALE_MS)
    })
})
