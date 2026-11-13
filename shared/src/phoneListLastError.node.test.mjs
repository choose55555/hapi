import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyAgentStateLastErrorPatch, applySummaryLastError, sameLastError, summaryLastError } from './phoneListLastError.ts'

const err = { kind: 'turn_error', message: '这一轮失败停止', occurredAt: 9 }

test('summary carries lastError from agent state', () => {
    assert.equal(summaryLastError(null), null)
    assert.equal(summaryLastError(undefined), null)
    assert.equal(summaryLastError({}), null)
    assert.equal(summaryLastError({ lastError: null }), null)
    assert.deepEqual(summaryLastError({ lastError: err }), err)
})

test('SSE patch writes lastError and an unchanged lastError stays equal', () => {
    const current = { id: 's1', lastError: null, agentStateVersion: 1 }
    const patched = applySummaryLastError(current, { lastError: err })
    assert.notEqual(patched, current)
    assert.deepEqual(patched.lastError, err)
    assert.equal(patched.id, 's1')
    assert.equal(sameLastError(current.lastError, patched.lastError), false)
    assert.equal(sameLastError(patched.lastError, { ...err }), true)
    assert.equal(sameLastError(undefined, null), true)
    assert.equal(sameLastError(err, { ...err, message: '别的' }), false)
    const again = applySummaryLastError(patched, { lastError: { ...err } })
    assert.equal(again, patched)
})

test('an agent-state patch writes lastError only when the version is new', () => {
    const current = { id: 's1', lastError: null, agentStateVersion: 2 }
    const stale = applyAgentStateLastErrorPatch(current, { version: 1, value: { lastError: err } })
    assert.equal(stale, current)
    assert.equal(stale.lastError, null)

    const missing = applyAgentStateLastErrorPatch(current, undefined)
    assert.equal(missing, current)

    const patched = applyAgentStateLastErrorPatch(current, { version: 2, value: { lastError: err } })
    assert.notEqual(patched, current)
    assert.deepEqual(patched.lastError, err)
    assert.equal(patched.id, 's1')

    const same = applyAgentStateLastErrorPatch(patched, { version: 3, value: { lastError: { ...err } } })
    assert.equal(same, patched)
})
