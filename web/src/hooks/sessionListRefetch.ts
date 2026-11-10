// Full-table refetch shares the existing 16ms invalidation batch.
// Teardown sends only a queued full-table refetch. Detail, scratchlist, and
// machine queues are cleared and not sent. Error and heartbeat reconnect
// use the same release.

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

export function reconnectTeardownReleasesQueuedFullTable(reason: string): boolean {
    return reason === 'transport-error'
        || reason === 'closed'
        || reason === 'heartbeat-timeout'
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

    const releaseQueuedFullTableOnly = () => {
        if (timer) {
            timer.cancel()
            timer = null
        }
        const sendFullTable = shouldFlushFullTableOnTeardown(pending.sessions)
        dropPending()
        if (!sendFullTable) {
            return
        }
        void Promise.resolve(options.invalidateSessions()).catch(() => {})
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
        releaseQueuedFullTableOnly,
        dispose() {
            releaseQueuedFullTableOnly()
        }
    }
}
