import { describe, expect, it } from 'vitest'
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
    enqueueThinkingClearsLastError,
    type PhoneAgentState
} from './phoneListFourState'

const now = 1_700_000_000_000

type HookState = PhoneAgentState & { requests?: { a?: number } }

function createAckQueue<T extends PhoneAgentState>(initial: T) {
    let agentState = initial
    let chain: Promise<void> = Promise.resolve()
    let sends = 0
    const update = (handler: (state: T) => T): void => {
        const run = chain.then(async () => {
            const current = agentState
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
        sends: () => sends,
        read: () => agentState,
        settled: () => chain
    }
}

describe('phone list lastError', () => {
    it('StopFailure writes turn_error and the next UserPromptSubmit clears it', () => {
        const start: HookState = { requests: { a: 1 }, lastError: null }
        const failed = applyLocalHookLastError('StopFailure', start, now)
        expect(failed).not.toBe(start)
        expect(failed.lastError).toEqual({
            kind: 'turn_error',
            message: TURN_ERROR_MESSAGE,
            occurredAt: now
        })
        expect(failed.requests).toBe(start.requests)
        const cleared = applyLocalHookLastError('UserPromptSubmit', failed, now + 10)
        expect(cleared.lastError).toBeNull()
    })

    it('PreToolUse and Stop clear an existing lastError and SessionEnd does not', () => {
        const empty: PhoneAgentState = { lastError: null }
        const failed = applyLocalHookLastError('StopFailure', empty, now)
        expect(applyLocalHookLastError('PreToolUse', failed, now).lastError).toBeNull()
        expect(applyLocalHookLastError('Stop', failed, now).lastError).toBeNull()
        expect(applyLocalHookLastError('SessionEnd', failed, now).lastError?.kind).toBe('turn_error')
    })

    it('keeps the same object when there is nothing to clear', () => {
        const state: HookState = { lastError: null, requests: {} }
        expect(applyLocalHookLastError('UserPromptSubmit', state, now)).toBe(state)
        expect(applyThinkingClearsLastError(true, state)).toBe(state)
        expect(applyRemoteUserMessageClearsLastError(state)).toBe(state)
    })

    it('writes process_error on an error exit and clears it on a normal end', () => {
        const start: HookState = { lastError: { kind: 'turn_error', message: 'old', occurredAt: 1 } }
        const crashed = applyEndLastError('error', 'Session crashed', start, now)
        expect(crashed.lastError).toEqual({
            kind: 'process_error',
            message: 'Session crashed',
            occurredAt: now
        })
        expect(applyEndLastError('terminated', 'Hub restart', crashed, now + 5).lastError).toBeNull()
        const alreadyClear: PhoneAgentState = { lastError: null }
        expect(applyEndLastError('completed', 'Session completed', alreadyClear, now)).toBe(alreadyClear)
    })

    it('does not send update-state when the handler returns the same object', () => {
        const current: HookState = { lastError: null, requests: {} }
        expect(commitAgentStateUpdate(current, current)).toEqual({ send: false, state: current })
        const failed = applyLocalHookLastError('StopFailure', current, now)
        expect(commitAgentStateUpdate(current, failed).send).toBe(true)
    })

    it('uses a two second archive flush budget', () => {
        expect(ARCHIVE_FLUSH_TIMEOUT_MS).toBe(2_000)
    })

    it('clears lastError when a new turn is queued before the error ack', async () => {
        const start: HookState = { requests: { a: 1 }, lastError: null }
        const queue = createAckQueue(start)
        enqueueLocalHookLastError('StopFailure', queue.update, now)
        enqueueLocalHookLastError('UserPromptSubmit', queue.update, now + 10)
        enqueueThinkingClearsLastError(true, queue.update)
        enqueueRemoteUserMessageClearsLastError(queue.update)
        expect(queue.read().lastError).toBeNull()
        await queue.settled()
        expect(queue.read().lastError).toBeNull()
        expect(queue.read().requests).toBe(start.requests)
    })

    it('clears lastError when a normal end is queued before the error ack', async () => {
        const queue = createAckQueue<PhoneAgentState>({ lastError: null })
        enqueueEndLastError('error', 'Session crashed', queue.update, now)
        enqueueEndLastError('completed', 'Session completed', queue.update, now + 5)
        await queue.settled()
        expect(queue.read().lastError).toBeNull()
        expect(queue.sends()).toBe(2)
    })
})
