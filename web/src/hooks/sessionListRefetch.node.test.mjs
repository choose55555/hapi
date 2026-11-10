import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    SESSION_LIST_REFETCH_BATCH_MS,
    applySessionRemovedToList,
    createInvalidationBatch,
    missingRowPatchLeavesList,
    ordinaryMessageQueuesFullTable,
    reconnectTeardownReleasesQueuedFullTable,
    sessionRemovedQueuesFullTable,
    summaryPatchMissesRow
} from './sessionListRefetch.ts'

function harness() {
    const cache = { sessions: [{ id: 'keep' }, { id: 'gone' }] }
    const calls = []
    const timers = []
    const batch = createInvalidationBatch({
        batchMs: SESSION_LIST_REFETCH_BATCH_MS,
        schedule(delay, run) {
            const timer = { delay, run, cancelled: false }
            timers.push(timer)
            return {
                cancel() {
                    timer.cancelled = true
                }
            }
        },
        invalidateSessions() {
            calls.push('sessions')
            cache.sessions = [{ id: 'keep' }, { id: 'gone' }]
        },
        invalidateSession(id) {
            calls.push('session:' + id)
        },
        invalidateScratchlist(id) {
            calls.push('scratch:' + id)
        },
        invalidateMachines() {
            calls.push('machines')
        }
    })
    return { cache, calls, timers, batch }
}

function sessionIds(cache) {
    return cache.sessions.map((item) => item.id)
}

test('整表排队留到 16 毫秒会发出，且两次合并成一次', () => {
    assert.equal(SESSION_LIST_REFETCH_BATCH_MS, 16)
    const { calls, timers, batch } = harness()
    batch.queueSessions()
    batch.queueSessions()
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 16)
    timers[0].run()
    assert.deepEqual(calls, ['sessions'])
})

test('删除后 16 毫秒内拆除，整表重取仍发出且编号回到缓存', () => {
    const { cache, calls, timers, batch } = harness()
    cache.sessions = applySessionRemovedToList(cache.sessions, 'gone')
    if (sessionRemovedQueuesFullTable()) {
        batch.queueSessions()
    }
    assert.deepEqual(sessionIds(cache), ['keep'])
    batch.dispose()
    assert.equal(calls.filter((item) => item === 'sessions').length, 1)
    assert.deepEqual(sessionIds(cache), ['keep', 'gone'])
    assert.equal(timers.every((timer) => timer.cancelled), true)
})

test('删除后缺行补丁不造行，16 毫秒内拆除仍重取且行回来', () => {
    const { cache, calls, batch } = harness()
    cache.sessions = applySessionRemovedToList(cache.sessions, 'gone')
    if (sessionRemovedQueuesFullTable()) {
        batch.queueSessions()
    }
    assert.equal(summaryPatchMissesRow(cache.sessions, 'gone'), true)
    const same = missingRowPatchLeavesList(cache)
    assert.equal(same, cache)
    assert.deepEqual(sessionIds(cache), ['keep'])
    batch.queueSessions()
    batch.dispose()
    assert.equal(calls.filter((item) => item === 'sessions').length, 1)
    assert.ok(sessionIds(cache).includes('gone'))
})

test('普通新消息不触发整表重取', () => {
    const { calls, timers, batch } = harness()
    if (ordinaryMessageQueuesFullTable()) {
        batch.queueSessions()
    }
    assert.equal(timers.length, 0)
    batch.dispose()
    assert.deepEqual(calls, [])
})

test('只有详情排队时拆除仍不拉整表', () => {
    const { calls, batch } = harness()
    batch.queueSession('keep')
    batch.dispose()
    assert.deepEqual(calls, [])
})

function queueMixed(batch) {
    batch.queueSessions()
    batch.queueSession('keep')
    batch.queueScratchlist('keep')
    batch.queueMachines()
}

function assertOnlyFullTableOnce(calls, timers) {
    assert.deepEqual(calls, ['sessions'])
    timers[0].run()
    assert.deepEqual(calls, ['sessions'])
}

test('整表、详情、机器、便签混合排队时拆除，只发整表一次，之后定时器不再调用', () => {
    const { calls, timers, batch } = harness()
    queueMixed(batch)
    batch.dispose()
    assertOnlyFullTableOnce(calls, timers)
})

test('错误或心跳超时触发的自动重连只补发整表，之后定时器不再调用', () => {
    for (const reason of ['transport-error', 'closed', 'heartbeat-timeout']) {
        const { calls, timers, batch } = harness()
        queueMixed(batch)
        assert.equal(reconnectTeardownReleasesQueuedFullTable(reason), true)
        batch.releaseQueuedFullTableOnly()
        assertOnlyFullTableOnce(calls, timers)
    }
    assert.equal(reconnectTeardownReleasesQueuedFullTable('visibility-recovery'), false)
})
