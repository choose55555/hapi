export const LIST_REFRESH_MIN_GAP_MS = 5000
export const OFFLINE_VERIFY_DELAY_MS = 2000

type ListRefreshGate = {
    request: (now: number) => boolean
}

type VerifyResult = {
    status: number
    active?: boolean
}

type CancelHandle = {
    cancel: () => void
}

type OfflineVerifier = {
    noteDrop: (sessionId: string) => void
    noteStateUpdated: (sessionId: string, active: boolean | undefined) => void
    dispose: () => void
}

let boundVerifier: {
    noteDrop: (sessionId: string) => void
    noteStateUpdated?: (sessionId: string, active: boolean | undefined) => void
} | null = null

let boundEvents: {
    upsert: (
        previousActive: boolean | undefined,
        session: { id?: string; active?: boolean } | null | undefined
    ) => void
    patch: (
        currentActive: boolean | undefined,
        sessionId: string,
        patch: { active?: boolean } | null | undefined
    ) => void
} | null = null

export function createListRefreshGate(minGapMs: number = LIST_REFRESH_MIN_GAP_MS): ListRefreshGate {
    let last = Number.NEGATIVE_INFINITY
    return {
        request(now: number): boolean {
            if (now - last < minGapMs) {
                return false
            }
            last = now
            return true
        }
    }
}

// List refresh is one query for the whole page, so the 5 second gap is per page,
// not per chat window. Detail messages stay on the caller's existing path.
export function planSessionListRefresh(args: {
    reason: 'visible' | 'connect'
    resumed?: boolean
    isFirstConnect?: boolean
    now: number
    gate: ListRefreshGate
}): { refreshList: boolean; refreshMessages: boolean } {
    const refreshList = args.gate.request(args.now)
    if (args.reason === 'visible') {
        return { refreshList, refreshMessages: false }
    }
    const replayOnly = args.resumed === true && args.isFirstConnect !== true
    return { refreshList, refreshMessages: !replayOnly }
}

// The page visibility listener calls this. The 5 second gap stays on the shared gate.
export function createPageVisibilityHandler(args: {
    readVisibility: () => string
    getGate: () => ListRefreshGate
    now: () => number
    invalidateList: () => void
}): () => void {
    return () => {
        if (args.readVisibility() !== 'visible') {
            return
        }
        const plan = planSessionListRefresh({
            reason: 'visible',
            now: args.now(),
            gate: args.getGate()
        })
        if (!plan.refreshList) {
            return
        }
        args.invalidateList()
    }
}

export function droppedOffline(previousActive: boolean | undefined, nextActive: boolean | undefined): boolean {
    return previousActive === true && nextActive === false
}

export function patchDropsOffline(
    currentActive: boolean | undefined,
    patch: { active?: boolean } | null | undefined
): boolean {
    if (!patch || patch.active === undefined) {
        return false
    }
    return droppedOffline(currentActive, patch.active)
}

export function notePatchOffline(
    currentActive: boolean | undefined,
    patch: { active?: boolean } | null | undefined,
    note: () => void
): void {
    if (patchDropsOffline(currentActive, patch)) {
        note()
    }
}

export function setSummaryActive<T extends { sessions?: Array<{ id?: string; active?: boolean }> }>(
    previous: T | undefined,
    sessionId: string,
    active: boolean
): T | undefined {
    if (!previous || !Array.isArray(previous.sessions)) {
        return previous
    }
    const index = previous.sessions.findIndex((item) => item && item.id === sessionId)
    if (index < 0) {
        return previous
    }
    const current = previous.sessions[index]
    if (!current || current.active === active) {
        return previous
    }
    const sessions = previous.sessions.slice()
    sessions[index] = { ...current, active }
    return { ...previous, sessions }
}

export function setDetailActive<T extends { session?: { active?: boolean } }>(
    previous: T | undefined,
    active: boolean
): T | undefined {
    if (!previous || !previous.session) {
        return previous
    }
    if (previous.session.active === active) {
        return previous
    }
    return { ...previous, session: { ...previous.session, active } }
}

export function applyVerifiedSessionActive(
    sessionId: string,
    active: boolean,
    writeList: (sessionId: string, active: boolean) => void,
    writeDetail: (sessionId: string, active: boolean) => void
): void {
    writeList(sessionId, active)
    writeDetail(sessionId, active)
}

export function removeSummary<T extends { sessions?: Array<{ id?: string }> }>(
    previous: T | undefined,
    sessionId: string
): T | undefined {
    if (!previous || !Array.isArray(previous.sessions)) {
        return previous
    }
    const sessions = previous.sessions.filter((item) => !item || item.id !== sessionId)
    if (sessions.length === previous.sessions.length) {
        return previous
    }
    return { ...previous, sessions }
}

export async function readSessionActive(
    load: (sessionId: string) => Promise<{ session?: { active?: boolean } }>,
    sessionId: string
): Promise<VerifyResult> {
    try {
        const body = await load(sessionId)
        const active = body && body.session ? body.session.active : undefined
        if (typeof active === 'boolean') {
            return { status: 200, active }
        }
        return { status: 200 }
    } catch (error) {
        const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
            ? error.status
            : 0
        return { status }
    }
}

export function createOfflineVerifier(options: {
    delayMs?: number
    schedule: (delayMs: number, run: () => Promise<void>) => CancelHandle
    fetchSession: (sessionId: string) => Promise<VerifyResult>
    applyActive: (sessionId: string, active: boolean) => void
    onMissing: (sessionId: string) => void
}): OfflineVerifier {
    const delayMs = options.delayMs ?? OFFLINE_VERIFY_DELAY_MS
    const pending = new Map<string, CancelHandle>()
    const inflight = new Set<string>()
    const generation = new Map<string, number>()
    const latestActive = new Map<string, boolean>()
    const offlineAgain = new Set<string>()
    let disposed = false

    const noteStateUpdated = (sessionId: string, active: boolean | undefined): void => {
        if (!sessionId || disposed) {
            return
        }
        const previous = latestActive.get(sessionId)
        generation.set(sessionId, (generation.get(sessionId) ?? 0) + 1)
        if (typeof active === 'boolean') {
            latestActive.set(sessionId, active)
        }
        // A new drop while the request is out arms one more check. Coming back
        // online clears that mark, so a later stale reply does not check again.
        // Repeating the same offline value does not arm another check.
        if (inflight.has(sessionId) && active === true) {
            offlineAgain.delete(sessionId)
        } else if (inflight.has(sessionId) && active === false && previous !== false) {
            offlineAgain.add(sessionId)
        }
    }

    const noteDrop = (sessionId: string): void => {
        if (!sessionId || disposed || pending.has(sessionId) || inflight.has(sessionId)) {
            return
        }
        const handle = options.schedule(delayMs, () => {
            pending.delete(sessionId)
            if (disposed) {
                return Promise.resolve()
            }
            // The count is taken when the request starts, not when the drop was noted.
            const seen = generation.get(sessionId) ?? 0
            offlineAgain.delete(sessionId)
            inflight.add(sessionId)
            let fetched: Promise<VerifyResult>
            try {
                fetched = Promise.resolve(options.fetchSession(sessionId))
            } catch {
                inflight.delete(sessionId)
                return Promise.resolve()
            }
            return fetched.then((result) => {
                inflight.delete(sessionId)
                if (disposed || !result) {
                    return
                }
                if ((generation.get(sessionId) ?? 0) !== seen) {
                    const again = offlineAgain.has(sessionId)
                    offlineAgain.delete(sessionId)
                    if (again && latestActive.get(sessionId) !== true) {
                        noteDrop(sessionId)
                    }
                    return
                }
                if (result.status === 404) {
                    options.onMissing(sessionId)
                    return
                }
                if (result.status === 200 && typeof result.active === 'boolean') {
                    latestActive.set(sessionId, result.active)
                    options.applyActive(sessionId, result.active)
                }
            }, () => {
                inflight.delete(sessionId)
            })
        })
        pending.set(sessionId, handle)
    }

    const dispose = (): void => {
        disposed = true
        for (const handle of pending.values()) {
            handle.cancel()
        }
        pending.clear()
        offlineAgain.clear()
    }

    return { noteDrop, noteStateUpdated, dispose }
}

export function bindListOfflineVerifier(verifier: { noteDrop: (sessionId: string) => void } | null): void {
    boundVerifier = verifier
}

export function noteListWentOffline(sessionId: string): void {
    if (!sessionId || !boundVerifier) {
        return
    }
    boundVerifier.noteDrop(sessionId)
}

export function noteSessionStateUpdated(sessionId: string, active: boolean | undefined): void {
    if (!sessionId || !boundVerifier || !boundVerifier.noteStateUpdated) {
        return
    }
    boundVerifier.noteStateUpdated(sessionId, active)
}

export function handleListedSessionUpsert(
    previousActive: boolean | undefined,
    session: { id?: string; active?: boolean } | null | undefined
): void {
    if (!session || !session.id) {
        return
    }
    noteSessionStateUpdated(session.id, session.active)
    if (droppedOffline(previousActive, session.active)) {
        noteListWentOffline(session.id)
    }
}

export function handleListedSessionPatch(
    currentActive: boolean | undefined,
    sessionId: string,
    patch: { active?: boolean } | null | undefined
): void {
    if (!sessionId) {
        return
    }
    const nextActive = patch && patch.active !== undefined ? patch.active : currentActive
    noteSessionStateUpdated(sessionId, nextActive)
    notePatchOffline(currentActive, patch, () => noteListWentOffline(sessionId))
}

type ListEventTarget = {
    addEventListener: (type: string, listener: () => void) => void
    removeEventListener: (type: string, listener: () => void) => void
}

// The page and the node tests both call this. It owns the foreground listener,
// the session-event entry, and the cache write. Callers only pass adapters.
export function createListOnlinePageController(options: {
    delayMs?: number
    schedule: (delayMs: number, run: () => Promise<void>) => CancelHandle
    fetchSession: (sessionId: string) => Promise<VerifyResult>
    writeListActive: (sessionId: string, active: boolean) => void
    writeDetailActive: (sessionId: string, active: boolean) => void
    removeSession: (sessionId: string) => void
}): {
    attachVisibility: (args: {
        eventTarget: ListEventTarget
        readVisibility: () => string
        getGate: () => ListRefreshGate
        now: () => number
        invalidateList: () => void
    }) => () => void
    dispose: () => void
} {
    const detachers: Array<() => void> = []
    let closed = false
    const verifier = createOfflineVerifier({
        delayMs: options.delayMs,
        schedule: options.schedule,
        fetchSession: options.fetchSession,
        applyActive(sessionId, active) {
            applyVerifiedSessionActive(sessionId, active, options.writeListActive, options.writeDetailActive)
        },
        onMissing(sessionId) {
            options.removeSession(sessionId)
        }
    })
    const upsert = (
        previousActive: boolean | undefined,
        session: { id?: string; active?: boolean } | null | undefined
    ): void => {
        handleListedSessionUpsert(previousActive, session)
    }
    const patchEvent = (
        currentActive: boolean | undefined,
        sessionId: string,
        sessionPatch: { active?: boolean } | null | undefined
    ): void => {
        handleListedSessionPatch(currentActive, sessionId, sessionPatch)
    }
    boundEvents = { upsert, patch: patchEvent }
    bindListOfflineVerifier(verifier)

    return {
        attachVisibility(args) {
            const onVisible = createPageVisibilityHandler({
                readVisibility: args.readVisibility,
                getGate: args.getGate,
                now: args.now,
                invalidateList: args.invalidateList
            })
            args.eventTarget.addEventListener('visibilitychange', onVisible)
            let removed = false
            const detach = () => {
                if (removed) {
                    return
                }
                removed = true
                args.eventTarget.removeEventListener('visibilitychange', onVisible)
            }
            detachers.push(detach)
            return detach
        },
        dispose() {
            if (closed) {
                return
            }
            closed = true
            for (const detach of detachers) {
                detach()
            }
            detachers.length = 0
            verifier.dispose()
            if (boundEvents && boundEvents.upsert === upsert) {
                boundEvents = null
            }
            bindListOfflineVerifier(null)
        }
    }
}

export function deliverListedSessionUpsert(
    previousActive: boolean | undefined,
    session: { id?: string; active?: boolean } | null | undefined
): void {
    if (!boundEvents) {
        return
    }
    boundEvents.upsert(previousActive, session)
}

export function deliverListedSessionPatch(
    currentActive: boolean | undefined,
    sessionId: string,
    patch: { active?: boolean } | null | undefined
): void {
    if (!sessionId || !boundEvents) {
        return
    }
    boundEvents.patch(currentActive, sessionId, patch)
}
