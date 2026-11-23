/**
 * Candidate adapter for `web/src/hooks/useVisibilityReporter.ts` calling `POST /api/visibility`
 * (pairs with `useSSE().reportVisibility404` in patch_03_useSSE.diff and App wiring in patch_03_App.diff).
 *
 * Revision 3 fixes (per Codex review):
 * 1. `reportVisibility404` now returns `boolean` (`true` ONLY when reconnect actually fired;
 *    `false` when skipped because page is hidden or subscriptionId already rotated).
 * 2. Dedup marker (`lastRecoveredDeadId`) is ONLY recorded when `reportVisibility404(sentId)`
 *    returns `true`. If a 404 arrives while the page is hidden, `reportVisibility404` defers
 *    recovery and returns `false`, so the adapter returns `'deferred-404-not-recovered'` WITHOUT
 *    poisoning dedup; upon returning to foreground with the same dead subscriptionId, the next
 *    404 (or `useSSE`'s own `hasPendingVisibility404` resume trigger) cleanly recovers.
 * 3. Supports both fetch-style `{ status, ok }` responses AND `ApiClient` thrown errors carrying
 *    `.status === 404` (e.g. `ApiError`).
 */

export interface VisibilityPostResponse {
    status?: number
    ok?: boolean
}

export interface VisibilityReporterDeps {
    postVisibility: (subscriptionId: string, visible: boolean) => Promise<VisibilityPostResponse | void>
    /**
     * Returns `true` if reconnect was actually triggered, or `false` if deferred/ignored
     * (e.g. page hidden or subscriptionId no longer matches).
     */
    reportVisibility404: (failedSubscriptionId: string | null | undefined) => boolean
    getCurrentSubscriptionId: () => string | null
}

export interface VisibilityReportResult {
    outcome:
        | 'skipped-no-subscription'
        | 'ok'
        | 'reconnected-404'
        | 'deferred-404-not-recovered'
        | 'stale-404-ignored'
        | 'duplicate-404-suppressed'
        | 'http-error'
        | 'network-error'
    status?: number
    sentSubscriptionId?: string
    error?: unknown
}

export function extractVisibilityHttpStatus(err: unknown): number | null {
    if (!err || typeof err !== 'object') return null
    const candidate = (err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } })
    if (typeof candidate.status === 'number' && Number.isFinite(candidate.status)) {
        return candidate.status
    }
    if (typeof candidate.statusCode === 'number' && Number.isFinite(candidate.statusCode)) {
        return candidate.statusCode
    }
    if (candidate.response && typeof candidate.response.status === 'number' && Number.isFinite(candidate.response.status)) {
        return candidate.response.status
    }
    return null
}

/**
 * Creates a single-flight/deduplicated visibility reporter that:
 * 1. Skips posting when `subscriptionId` is absent.
 * 2. Captures `sentId` before awaiting the HTTP call so rotated IDs are never misattributed.
 * 3. On HTTP 404 (returned or thrown) for the still-active `sentId`:
 *    - calls `reportVisibility404(sentId)`;
 *    - ONLY marks `lastRecoveredDeadId = sentId` when `reportVisibility404` returns `true`;
 *    - if `reportVisibility404` returns `false` (hidden page / deferred), returns
 *      `'deferred-404-not-recovered'` so returning to foreground is NEVER suppressed by dedup!
 */
export function createVisibilityReporter(deps: VisibilityReporterDeps) {
    let lastRecoveredDeadId: string | null = null

    function handle404(sentId: string): VisibilityReportResult {
        const currentId = deps.getCurrentSubscriptionId()
        if (currentId !== sentId) {
            return { outcome: 'stale-404-ignored', status: 404, sentSubscriptionId: sentId }
        }
        if (lastRecoveredDeadId === sentId) {
            return { outcome: 'duplicate-404-suppressed', status: 404, sentSubscriptionId: sentId }
        }
        const triggered = deps.reportVisibility404(sentId) === true
        if (!triggered) {
            return { outcome: 'deferred-404-not-recovered', status: 404, sentSubscriptionId: sentId }
        }
        lastRecoveredDeadId = sentId
        return { outcome: 'reconnected-404', status: 404, sentSubscriptionId: sentId }
    }

    return async function reportVisibility(visible: boolean): Promise<VisibilityReportResult> {
        const sentId = deps.getCurrentSubscriptionId()
        if (!sentId) {
            return { outcome: 'skipped-no-subscription' }
        }
        // Reset dedup marker once a brand-new subscriptionId is active.
        if (lastRecoveredDeadId !== null && lastRecoveredDeadId !== sentId) {
            lastRecoveredDeadId = null
        }

        let res: VisibilityPostResponse | void
        try {
            res = await deps.postVisibility(sentId, visible)
        } catch (err) {
            const status = extractVisibilityHttpStatus(err)
            if (status === 404) {
                return handle404(sentId)
            }
            if (status !== null) {
                return { outcome: 'http-error', status, sentSubscriptionId: sentId, error: err }
            }
            return { outcome: 'network-error', sentSubscriptionId: sentId, error: err }
        }

        if (!res) {
            return { outcome: 'ok', status: 204, sentSubscriptionId: sentId }
        }

        const status = res.status
        if (status === 404) {
            return handle404(sentId)
        }

        const details = status === undefined
            ? { sentSubscriptionId: sentId }
            : { status, sentSubscriptionId: sentId }
        if (res.ok === true || (status !== undefined && status >= 200 && status < 300)) {
            return { outcome: 'ok', ...details }
        }

        return { outcome: 'http-error', ...details }
    }
}
