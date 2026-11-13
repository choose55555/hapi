import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import {
    ARCHIVE_FLUSH_TIMEOUT_MS,
    TURN_ERROR_MESSAGE,
    applyEndLastError,
    applyLocalHookLastError,
    applyRemoteUserMessageClearsLastError,
    applyThinkingClearsLastError,
    commitAgentStateUpdate,
    enqueueEndLastError,
    enqueueLocalHookLastError,
    enqueueRemoteUserMessageClearsLastError,
    enqueueThinkingClearsLastError
} from './phoneListFourState.ts'

function createAckQueue(initial) {
    let agentState = initial
    let chain = Promise.resolve()
    let calls = 0
    let sends = 0
    function update(handler) {
        calls += 1
        const run = chain.then(async () => {
            const current = agentState ?? {}
            const updated = handler(current)
            const committed = commitAgentStateUpdate(current, updated)
            if (!committed.send) return
            sends += 1
            await Promise.resolve()
            agentState = committed.state
        })
        chain = run
    }
    return {
        update,
        calls: () => calls,
        sends: () => sends,
        read: () => agentState,
        settled: () => chain
    }
}

const now = 1_700_000_000_000

test('StopFailure writes turn_error and the next UserPromptSubmit clears it', () => {
    const start = { requests: { a: 1 } }
    const failed = applyLocalHookLastError('StopFailure', start, now)
    assert.notEqual(failed, start)
    assert.deepEqual(failed.lastError, {
        kind: 'turn_error',
        message: TURN_ERROR_MESSAGE,
        occurredAt: now
    })
    assert.equal(failed.requests, start.requests)
    const cleared = applyLocalHookLastError('UserPromptSubmit', failed, now + 10)
    assert.equal(cleared.lastError, null)
    assert.equal(cleared.requests.a, 1)
})

test('PreToolUse and Stop also clear an existing lastError', () => {
    const failed = applyLocalHookLastError('StopFailure', {}, now)
    assert.equal(applyLocalHookLastError('PreToolUse', failed, now).lastError, null)
    assert.equal(applyLocalHookLastError('Stop', failed, now).lastError, null)
    assert.equal(applyLocalHookLastError('SessionEnd', failed, now).lastError.kind, 'turn_error')
})

test('clearing when lastError is already empty keeps the same object', () => {
    const state = { lastError: null, requests: {} }
    assert.equal(applyLocalHookLastError('UserPromptSubmit', state, now), state)
    assert.equal(applyLocalHookLastError('PreToolUse', state, now), state)
    assert.equal(applyLocalHookLastError('Stop', state, now), state)
    assert.equal(applyThinkingClearsLastError(true, state), state)
    assert.equal(applyRemoteUserMessageClearsLastError(state), state)
})

test('process error writes process_error and a normal end clears the old lastError', () => {
    const start = { lastError: { kind: 'turn_error', message: 'old', occurredAt: 1 } }
    const crashed = applyEndLastError('error', 'Session crashed', start, now)
    assert.deepEqual(crashed.lastError, {
        kind: 'process_error',
        message: 'Session crashed',
        occurredAt: now
    })
    const finished = applyEndLastError('terminated', 'Hub restart', crashed, now + 5)
    assert.equal(finished.lastError, null)
    const alreadyClear = { lastError: null }
    assert.equal(applyEndLastError('completed', 'Session completed', alreadyClear, now), alreadyClear)
    const empty = {}
    assert.equal(applyEndLastError('terminated', 'Hub restart', empty, now), empty)
})

test('updateAgentState does not send when the handler returns the same object', () => {
    const current = { lastError: null, requests: {} }
    const skipped = commitAgentStateUpdate(current, current)
    assert.equal(skipped.send, false)
    assert.equal(skipped.state, current)

    let sends = 0
    const box = { agentState: current }
    const run = (handler) => {
        const committed = commitAgentStateUpdate(box.agentState, handler(box.agentState))
        if (!committed.send) return
        sends += 1
        box.agentState = committed.state
    }
    run((state) => applyLocalHookLastError('UserPromptSubmit', state, now))
    assert.equal(sends, 0)
    run((state) => applyLocalHookLastError('StopFailure', state, now))
    assert.equal(sends, 1)
    assert.equal(box.agentState.lastError.kind, 'turn_error')
    run((state) => applyEndLastError('completed', 'Session completed', state, now + 3))
    assert.equal(sends, 2)
    assert.equal(box.agentState.lastError, null)
    run((state) => applyEndLastError('completed', 'Session completed', state, now + 4))
    assert.equal(sends, 2)
})

test('thinking true clears lastError and thinking false leaves a turn error', () => {
    const failed = applyLocalHookLastError('StopFailure', {}, now)
    assert.equal(applyThinkingClearsLastError(false, failed).lastError.kind, 'turn_error')
    assert.equal(applyThinkingClearsLastError(true, failed).lastError, null)
})

test('a remote user message clears lastError', () => {
    const failed = applyLocalHookLastError('StopFailure', {}, now)
    assert.equal(applyRemoteUserMessageClearsLastError(failed).lastError, null)
})

test('archive flush budget is two seconds', () => {
    assert.equal(ARCHIVE_FLUSH_TIMEOUT_MS, 2_000)
})

test('a new turn during a delayed error ack ends with no lastError', async () => {
    const queue = createAckQueue({ requests: { a: 1 } })
    enqueueLocalHookLastError('StopFailure', queue.update, now)
    enqueueLocalHookLastError('UserPromptSubmit', queue.update, now + 10)
    enqueueThinkingClearsLastError(true, queue.update)
    enqueueRemoteUserMessageClearsLastError(queue.update)
    assert.equal(queue.read().lastError, undefined)
    await queue.settled()
    assert.equal(queue.read().lastError, null)
    assert.equal(queue.read().requests.a, 1)
})

test('a normal end queued while an error write is still waiting ends with no lastError', async () => {
    const queue = createAckQueue({})
    enqueueEndLastError('error', 'Session crashed', queue.update, now)
    enqueueEndLastError('completed', 'Session completed', queue.update, now + 5)
    assert.equal(queue.read().lastError, undefined)
    await queue.settled()
    assert.equal(queue.read().lastError, null)
    assert.equal(queue.sends(), 2)
})

test('an unchanged clear still does not send', async () => {
    const queue = createAckQueue({ lastError: null, requests: {} })
    enqueueLocalHookLastError('UserPromptSubmit', queue.update, now)
    enqueueThinkingClearsLastError(false, queue.update)
    enqueueEndLastError('completed', 'Session completed', queue.update, now)
    await queue.settled()
    assert.equal(queue.sends(), 0)
    assert.equal(queue.read().lastError, null)
})

test('clear paths do not skip the queue by reading lastError first', () => {
    const files = [
        new URL('./runnerLifecycle.ts', import.meta.url),
        new URL('./sessionBase.ts', import.meta.url),
        new URL('../claude/runClaude.ts', import.meta.url)
    ]
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8')
        assert.equal(text.includes('getAgentState()?.lastError'), false, file.pathname)
    }
})
