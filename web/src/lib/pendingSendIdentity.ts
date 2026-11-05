type Identity = { localId: string; createdAt: number }
export type PendingSendIdentity = Identity & { storageKey: string | null }

/** Same-origin, per-tab draft identity. Scope is the existing origin/namespace
 * read-state scope, never the bearer token. No identity is shared across users.
 * Browser storage denial degrades to the hook's existing in-memory identity.
 */
export function pendingSendIdentity(scope: string | null, intent: string, allocate: () => Identity): PendingSendIdentity {
    const storageKey = scope ? JSON.stringify(['hapi-pending-send-v1', scope, intent]) : null
    if (storageKey) {
        try {
            const raw = sessionStorage.getItem(storageKey)
            if (raw) {
                const value = JSON.parse(raw) as Partial<Identity>
                if (typeof value.localId === 'string' && value.localId.length > 0
                    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)) {
                    return { localId: value.localId, createdAt: value.createdAt, storageKey }
                }
            }
        } catch { /* Storage may be disabled, keep ordinary sends available. */ }
    }
    const identity = allocate()
    if (storageKey) {
        try { sessionStorage.setItem(storageKey, JSON.stringify(identity)) } catch { /* In-memory retry remains available. */ }
    }
    return { ...identity, storageKey }
}

export function forgetSendIdentity(storageKey: string | null | undefined): void {
    if (!storageKey) return
    try { sessionStorage.removeItem(storageKey) } catch { /* No other browser data is touched. */ }
}
