import { describe, expect, it } from 'vitest'
import { sessionRowStatus, sessionRowVisibleText } from './sessionRowFourState'

function row(overrides: Partial<Parameters<typeof sessionRowStatus>[0]> = {}) {
    return sessionRowStatus({
        active: true,
        thinking: false,
        backgroundTaskCount: 0,
        pendingRequestsCount: 0,
        lastError: null,
        lifecycleState: null,
        inRunningSection: false,
        ...overrides
    })
}

const turnError = { kind: 'turn_error' as const, message: '这一轮失败停止', occurredAt: 1 }

describe('session row four states', () => {
    it('shows waiting ahead of running, error, and idle, without the old pending count', () => {
        expect(row({
            pendingRequestsCount: 2,
            thinking: true,
            backgroundTaskCount: 3,
            lastError: turnError
        })).toMatchObject({ titleStatus: '等待 2', tone: 'warning', showTrailingPendingCount: false })
        expect(row({ pendingRequestsCount: 1, thinking: true }).titleStatus).toBe('等待')
        expect(row({ thinking: true, lastError: turnError }).titleStatus).toBe('运行')
        expect(row({ backgroundTaskCount: 1, lastError: turnError }).titleStatus).toBe('运行')
        expect(row({ active: false, lastError: turnError, lifecycleState: 'archived' })).toMatchObject({
            titleStatus: '出错',
            tone: 'error',
            errorTitle: '这一轮失败停止'
        })
        expect(row({}).titleStatus).toBe('空闲')
    })

    it('shows archived or offline when disconnected, and no status word in the running section', () => {
        expect(row({ active: false, lifecycleState: 'archived' }).titleStatus).toBe('已归档')
        expect(row({ active: false }).titleStatus).toBe('离线')
        expect(row({
            pendingRequestsCount: 3,
            thinking: true,
            lastError: turnError,
            inRunningSection: true
        })).toMatchObject({ titleStatus: null, showTrailingPendingCount: false, isWaiting: true })
    })

    it('renders one status word, and waiting is not repeated beside the time', () => {
        expect(sessionRowVisibleText({
            active: true,
            thinking: true,
            backgroundTaskCount: 3,
            pendingRequestsCount: 2,
            lastError: turnError,
            inRunningSection: false
        })).toMatchObject({ text: '等待 2', showTrailingPendingCount: false })
        expect(sessionRowVisibleText({
            active: true,
            thinking: true,
            lastError: turnError,
            inRunningSection: false
        }).text).toBe('运行')
        expect(sessionRowVisibleText({
            active: false,
            thinking: false,
            lastError: turnError,
            lifecycleState: 'archived',
            inRunningSection: false
        })).toMatchObject({ text: '出错', errorTitle: '这一轮失败停止' })
        expect(sessionRowVisibleText({
            active: true,
            thinking: false,
            inRunningSection: false
        }).text).toBe('空闲')
        expect(sessionRowVisibleText({
            active: false,
            thinking: false,
            lifecycleState: 'archived',
            inRunningSection: false
        }).text).toBe('已归档')
        expect(sessionRowVisibleText({
            active: false,
            thinking: false,
            inRunningSection: false
        }).text).toBe('离线')
        expect(sessionRowVisibleText({
            active: true,
            thinking: true,
            pendingRequestsCount: 2,
            inRunningSection: true
        }).text).toBeNull()
    })
})
