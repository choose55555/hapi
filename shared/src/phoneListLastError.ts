export type PhoneLastError = {
    kind: 'turn_error' | 'process_error'
    message: string
    occurredAt: number
}

type AgentStateLike = {
    lastError?: PhoneLastError | null
} | null | undefined

export function summaryLastError(agentState: AgentStateLike): PhoneLastError | null {
    return agentState?.lastError ?? null
}

export function sameLastError(
    current: PhoneLastError | null | undefined,
    next: PhoneLastError | null | undefined
): boolean {
    return (current?.kind ?? null) === (next?.kind ?? null)
        && (current?.message ?? null) === (next?.message ?? null)
        && (current?.occurredAt ?? null) === (next?.occurredAt ?? null)
}

export function applySummaryLastError<T extends { lastError?: PhoneLastError | null }>(
    summary: T,
    agentState: AgentStateLike
): T {
    const lastError = summaryLastError(agentState)
    if (sameLastError(summary.lastError, lastError)) return summary
    return { ...summary, lastError }
}

export function applyAgentStateLastErrorPatch<T extends {
    lastError?: PhoneLastError | null
    agentStateVersion: number
}>(
    summary: T,
    agentState: { version: number, value: AgentStateLike } | undefined
): T {
    if (agentState === undefined || agentState.version < summary.agentStateVersion) return summary
    return applySummaryLastError(summary, agentState.value)
}
