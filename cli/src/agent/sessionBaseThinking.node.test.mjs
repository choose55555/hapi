import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentSessionBase } from './sessionBase.ts'

function openSession(client) {
    return new AgentSessionBase({
        api: {},
        client,
        path: 'p',
        logPath: 'l',
        sessionId: null,
        messageQueue: {},
        onModeChange() {},
        sessionLabel: 'test',
        sessionIdLabel: 'id',
        applySessionIdToMetadata: (metadata) => metadata,
        acknowledgeMessagesOnDequeue: false
    })
}

test('onThinkingChange(true) does not throw when the client has no updateAgentState', () => {
    const client = { keepAlive() {} }
    const session = openSession(client)
    try {
        assert.equal(typeof client.updateAgentState, 'undefined')
        assert.doesNotThrow(() => session.onThinkingChange(true))
        assert.equal(session.thinking, true)
        assert.doesNotThrow(() => session.onThinkingChange(false))
        assert.equal(session.thinking, false)
    } finally {
        session.stopKeepAlive()
    }
})

test('onThinkingChange queues a clear only when thinking becomes true and the client has updateAgentState', () => {
    const seen = []
    const client = {
        keepAlive() {},
        updateAgentState(handler) {
            seen.push(handler({ lastError: { kind: 'turn_error', message: 'old', occurredAt: 1 } }))
        }
    }
    const session = openSession(client)
    try {
        session.onThinkingChange(false)
        assert.equal(seen.length, 0)
        session.onThinkingChange(true)
        assert.equal(seen.length, 1)
        assert.equal(seen[0].lastError, null)
        session.onThinkingChange(true)
        assert.equal(seen.length, 1)
        session.onThinkingChange(false)
        session.onThinkingChange(true)
        assert.equal(seen.length, 2)
        assert.equal(seen[1].lastError, null)
    } finally {
        session.stopKeepAlive()
    }
})
