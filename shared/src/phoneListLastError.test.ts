import { describe, expect, it } from 'bun:test'
import { applyAgentStateLastErrorPatch, applySummaryLastError, sameLastError, summaryLastError } from './phoneListLastError'

const err = { kind: 'turn_error' as const, message: '这一轮失败停止', occurredAt: 9 }

describe('phone list lastError summary', () => {
    it('carries lastError from agent state onto the summary', () => {
        expect(summaryLastError(null)).toBeNull()
        expect(summaryLastError(undefined)).toBeNull()
        expect(summaryLastError({})).toBeNull()
        expect(summaryLastError({ lastError: err })).toEqual(err)
    })

    it('SSE patch writes lastError and leaves an unchanged value on the same object', () => {
        const current = { id: 's1', lastError: null, agentStateVersion: 1 }
        const patched = applySummaryLastError(current, { lastError: err })
        expect(patched).not.toBe(current)
        expect(patched.lastError).toEqual(err)
        expect(sameLastError(current.lastError, patched.lastError)).toBe(false)
        expect(sameLastError(patched.lastError, { ...err })).toBe(true)
        expect(sameLastError(undefined, null)).toBe(true)
        expect(applySummaryLastError(patched, { lastError: { ...err } })).toBe(patched)
    })

    it('writes lastError from an agent-state patch and ignores an older version', () => {
        const current = { id: 's1', lastError: null, agentStateVersion: 2 }
        expect(applyAgentStateLastErrorPatch(current, { version: 1, value: { lastError: err } })).toBe(current)
        expect(applyAgentStateLastErrorPatch(current, undefined)).toBe(current)
        const patched = applyAgentStateLastErrorPatch(current, { version: 2, value: { lastError: err } })
        expect(patched.lastError).toEqual(err)
        expect(applyAgentStateLastErrorPatch(patched, { version: 3, value: { lastError: { ...err } } })).toBe(patched)
    })
})
