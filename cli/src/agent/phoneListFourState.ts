export const TURN_ERROR_MESSAGE = '这一轮失败停止'

export const ARCHIVE_FLUSH_TIMEOUT_MS = 2_000

export type PhoneLastError = {
    kind: 'turn_error' | 'process_error'
    message: string
    occurredAt: number
}

export type PhoneAgentState = {
    lastError?: PhoneLastError | null
}

const CLEAR_HOOK_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'Stop'])

export function applyLocalHookLastError<T extends PhoneAgentState>(
    event: string,
    state: T,
    now: number
): T {
    if (event === 'StopFailure') {
        return {
            ...state,
            lastError: {
                kind: 'turn_error',
                message: TURN_ERROR_MESSAGE,
                occurredAt: now
            }
        }
    }
    if (CLEAR_HOOK_EVENTS.has(event) && state.lastError != null) {
        return { ...state, lastError: null }
    }
    return state
}

export function applyEndLastError<T extends PhoneAgentState>(
    sessionEndReason: string,
    archiveReason: string,
    state: T,
    now: number
): T {
    if (sessionEndReason === 'error') {
        return {
            ...state,
            lastError: {
                kind: 'process_error',
                message: archiveReason,
                occurredAt: now
            }
        }
    }
    if (state.lastError == null) return state
    return { ...state, lastError: null }
}

export function applyThinkingClearsLastError<T extends PhoneAgentState>(
    thinking: boolean,
    state: T
): T {
    if (thinking && state.lastError != null) {
        return { ...state, lastError: null }
    }
    return state
}

export function applyRemoteUserMessageClearsLastError<T extends PhoneAgentState>(state: T): T {
    if (state.lastError == null) return state
    return { ...state, lastError: null }
}

export function commitAgentStateUpdate<T>(current: T, updated: T): { send: boolean, state: T } {
    if (updated === current) return { send: false, state: current }
    return { send: true, state: updated }
}

export function enqueueLocalHookLastError<T extends PhoneAgentState>(
    event: string,
    updateAgentState: (handler: (state: T) => T) => void,
    now: number
): void {
    if (event !== 'StopFailure' && !CLEAR_HOOK_EVENTS.has(event)) return
    updateAgentState((state) => applyLocalHookLastError(event, state, now))
}

export function enqueueThinkingClearsLastError<T extends PhoneAgentState>(
    thinking: boolean,
    updateAgentState: (handler: (state: T) => T) => void
): void {
    if (!thinking) return
    updateAgentState((state) => applyThinkingClearsLastError(true, state))
}

export function enqueueRemoteUserMessageClearsLastError<T extends PhoneAgentState>(
    updateAgentState: (handler: (state: T) => T) => void
): void {
    updateAgentState((state) => applyRemoteUserMessageClearsLastError(state))
}

export function enqueueEndLastError<T extends PhoneAgentState>(
    sessionEndReason: string,
    archiveReason: string,
    updateAgentState: (handler: (state: T) => T) => void,
    now: number
): void {
    updateAgentState((state) => applyEndLastError(sessionEndReason, archiveReason, state, now))
}
