import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionRowStatus, sessionRowVisibleText } from './sessionRowFourState.ts'

function row(overrides) {
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

const turnError = { kind: 'turn_error', message: '这一轮失败停止', occurredAt: 1 }

test('list priority is waiting, then running, then error, then idle', () => {
    const waiting = row({
        pendingRequestsCount: 2,
        thinking: true,
        backgroundTaskCount: 3,
        lastError: turnError
    })
    assert.equal(waiting.titleStatus, '等待 2')
    assert.equal(waiting.tone, 'warning')
    assert.equal(waiting.showTrailingPendingCount, false)

    const one = row({ pendingRequestsCount: 1, thinking: true, lastError: turnError })
    assert.equal(one.titleStatus, '等待')
    assert.equal(one.showTrailingPendingCount, false)

    const running = row({ thinking: true, lastError: turnError })
    assert.equal(running.titleStatus, '运行')
    assert.equal(running.tone, 'success')

    const background = row({ backgroundTaskCount: 1, lastError: turnError })
    assert.equal(background.titleStatus, '运行')

    const broken = row({ active: false, lastError: turnError, lifecycleState: 'archived' })
    assert.equal(broken.titleStatus, '出错')
    assert.equal(broken.tone, 'error')
    assert.equal(broken.errorTitle, '这一轮失败停止')

    const idle = row({})
    assert.equal(idle.titleStatus, '空闲')
    assert.equal(idle.tone, 'hint')
})

test('a disconnected row shows archived or offline, and the running section writes no status word', () => {
    assert.equal(row({ active: false, lifecycleState: 'archived' }).titleStatus, '已归档')
    assert.equal(row({ active: false, lifecycleState: null }).titleStatus, '离线')
    assert.equal(row({ active: false }).titleStatus, '离线')
    const pinned = row({
        pendingRequestsCount: 3,
        thinking: true,
        lastError: turnError,
        inRunningSection: true
    })
    assert.equal(pinned.titleStatus, null)
    assert.equal(pinned.showTrailingPendingCount, false)
    assert.equal(pinned.isWaiting, true)
})

test('the rendered row text is one status word and waiting is not repeated', () => {
    const waiting = sessionRowVisibleText({
        active: true,
        thinking: true,
        backgroundTaskCount: 3,
        pendingRequestsCount: 2,
        lastError: turnError,
        lifecycleState: null,
        inRunningSection: false
    })
    assert.equal(waiting.text, '等待 2')
    assert.equal(waiting.showTrailingPendingCount, false)
    assert.equal(`${waiting.text}`, '等待 2')

    assert.equal(sessionRowVisibleText({
        active: true,
        thinking: true,
        pendingRequestsCount: 1,
        lastError: null,
        inRunningSection: false
    }).text, '等待')

    const running = sessionRowVisibleText({
        active: true,
        thinking: true,
        lastError: turnError,
        inRunningSection: false
    })
    assert.equal(running.text, '运行')
    assert.equal(running.errorTitle, undefined)

    const broken = sessionRowVisibleText({
        active: false,
        thinking: false,
        lastError: turnError,
        lifecycleState: 'archived',
        inRunningSection: false
    })
    assert.equal(broken.text, '出错')
    assert.equal(broken.errorTitle, '这一轮失败停止')

    assert.equal(sessionRowVisibleText({
        active: true,
        thinking: false,
        lastError: null,
        inRunningSection: false
    }).text, '空闲')
    assert.equal(sessionRowVisibleText({
        active: false,
        thinking: false,
        lastError: null,
        lifecycleState: 'archived',
        inRunningSection: false
    }).text, '已归档')
    assert.equal(sessionRowVisibleText({
        active: false,
        thinking: false,
        lastError: null,
        inRunningSection: false
    }).text, '离线')
    assert.equal(sessionRowVisibleText({
        active: true,
        thinking: true,
        pendingRequestsCount: 2,
        lastError: turnError,
        inRunningSection: true
    }).text, null)
    assert.equal(sessionRowVisibleText({
        active: true,
        thinking: true,
        lastError: turnError,
        inRunningSection: false,
        urgentAttention: true
    }).text, '等待')
})
