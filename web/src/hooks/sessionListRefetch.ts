// Full-table refetch shares the existing 16ms invalidation batch.
// Teardown must send a queued full-table refetch; other queued work stays dropped.

export const SESSION_LIST_REFETCH_BATCH_MS = 16

export type CancelHandle = {
    cancel: () => void
}

type BatchOptions = {
    batchMs: number
    schedule: (delayMs: number, run: () => void) => CancelHandle
    invalidateSessions: () => unknown
    invalidateSession: (sessionId: string) => unknown
    invalidateScratchlist: (sessionId: string) => unknown
    invalidateMachines: () => unknown
}

export function sessionRemovedQueuesFullTable(): boolean {
    return true
}

export function ordinaryMessageQueuesFullTable(): boolean {
    return false
}

export function applySessionRemovedToList<T extends { id: string }>(sessions: T[], sessionId: string): T[] {
    return sessions.filter((item) => item.id !== sessionId)
}

export function summaryPatchMissesRow<T extends { id: string }>(sessions: T[], sessionId: string): boolean {
    return !sessions.some((item) => item.id === sessionId)
}

export function missingRowPatchLeavesList<T>(previous: T): T {
    return previous
}

export function shouldFlushFullTableOnTeardown(sessionsQueued: boolean): boolean {
    return sessionsQueued
}

export function createInvalidationBatch(options: BatchOptions) {
    const pending = {
        sessions: false,
        machines: false,
        sessionIds: new Set<string>(),
        scratchlistSessionIds: new Set<string>()
    }
    let timer: CancelHandle | null = null

    const flush = () => {
        if (
            !pending.sessions
            && !pending.machines
            && pending.sessionIds.size === 0
            && pending.scratchlistSessionIds.size === 0
        ) {
            return
        }

        const shouldInvalidateSessions = pending.sessions
        const shouldInvalidateMachines = pending.machines
        const sessionIds = Array.from(pending.sessionIds)
        const scratchlistSessionIds = Array.from(pending.scratchlistSessionIds)
        pending.sessions = false
        pending.machines = false
        pending.sessionIds.clear()
        pending.scratchlistSessionIds.clear()

        const tasks: unknown[] = []
        if (shouldInvalidateSessions) {
            tasks.push(options.invalidateSessions())
        }
        for (const sessionId of sessionIds) {
            tasks.push(options.invalidateSession(sessionId))
        }
        for (const sessionId of scratchlistSessionIds) {
            tasks.push(options.invalidateScratchlist(sessionId))
        }
        if (shouldInvalidateMachines) {
            tasks.push(options.invalidateMachines())
        }
        if (tasks.length === 0) {
            return
        }
        void Promise.all(tasks).catch(() => {})
    }

    const scheduleFlush = () => {
        if (timer) {
            return
        }
        timer = options.schedule(options.batchMs, () => {
            timer = null
            flush()
        })
    }

    const dropPending = () => {
        pending.sessions = false
        pending.machines = false
        pending.sessionIds.clear()
        pending.scratchlistSessionIds.clear()
    }

    return {
        queueSessions() {
            pending.sessions = true
            scheduleFlush()
        },
        queueSession(sessionId: string) {
            pending.sessionIds.add(sessionId)
            scheduleFlush()
        },
        queueScratchlist(sessionId: string) {
            pending.scratchlistSessionIds.add(sessionId)
            scheduleFlush()
        },
        queueMachines() {
            pending.machines = true
            scheduleFlush()
        },
        dispose() {
            if (timer) {
                timer.cancel()
                timer = null
            }
            if (!shouldFlushFullTableOnTeardown(pending.sessions)) {
                dropPending()
                return
            }
            flush()
        }
    }
}
