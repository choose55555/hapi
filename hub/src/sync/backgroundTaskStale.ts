import type { Session } from '@hapi/protocol/types'

export const DEFAULT_BACKGROUND_TASK_STALE_MS = 60 * 60 * 1000

export function resolveBackgroundTaskStaleMs(env: Record<string, string | undefined> = process.env): number {
    const raw = env.HAPI_BACKGROUND_TASK_STALE_MS
    if (raw === undefined || raw.trim() === '') return DEFAULT_BACKGROUND_TASK_STALE_MS
    const parsed = Number(raw.trim())
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_BACKGROUND_TASK_STALE_MS
}

export function shouldClearStaleBackgroundTasks(session: Session, agentProgressAt: number, now: number, staleMs: number): boolean {
    if (staleMs <= 0 || (session.backgroundTaskCount ?? 0) <= 0 || session.thinking) return false
    if (Object.keys(session.agentState?.requests ?? {}).length > 0) return false
    return now - agentProgressAt > staleMs
}
