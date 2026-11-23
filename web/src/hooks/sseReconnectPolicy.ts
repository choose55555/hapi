/**
 * Candidate pure reconnect & visibility-recovery policy for web/src/hooks/useSSE.ts
 *
 * Addresses Bug 2 (frequent online/offline oscillation over mobile Tailscale DERP
 * and POST /api/visibility 404 storms on foreground resume).
 *
 * Revision 3 fix (per Codex review):
 * - Separates hidden-page 404 (`defer-until-visible`) from foreground 404 (`reconnect-now`)
 *   so hidden 404s never poison caller dedup AND still trigger immediate reconnect upon
 *   returning to foreground regardless of silence duration.
 *
 * Revision 4 fix (per Codex 3rd review):
 * - Raises `SSE_VISIBILITY_RESUME_STALE_MS` from 15s to 75s (> 30s Hub heartbeat interval,
 *   2.5x heartbeat, below 90s visible watchdog) so healthy SSE connections returning to
 *   foreground within normal heartbeat intervals only do a lightweight list refresh and
 *   are NEVER falsely torn down and rebuilt.
 */

export const SSE_HUB_HEARTBEAT_INTERVAL_MS = 30_000
export const SSE_HEARTBEAT_STALE_MS = 90_000
// Hub sends a heartbeat every 30s. Keep foreground-resume stale threshold at 75s
// (2.5x heartbeat interval, safely below the 90s visible watchdog) so healthy
// connections are NEVER falsely rebuilt when returning to foreground between
// normal heartbeats; 10s..75s only runs a lightweight session-list refresh.
export const SSE_VISIBILITY_RESUME_STALE_MS = 75_000
// Light list refresh threshold when returning to foreground without full SSE teardown.
export const SSE_VISIBILITY_LIGHT_REFRESH_MS = 10_000
// Slightly relax connect timeout from 10s -> 15s to tolerate Tailscale DERP jitter.
export const SSE_CONNECT_TIMEOUT_MS = 15_000
export const SSE_RECONNECT_BASE_DELAY_MS = 1_000
export const SSE_RECONNECT_MAX_DELAY_MS = 20_000
export const SSE_RECONNECT_JITTER_MS = 500
export const SSE_RECONNECT_SLOW_AFTER_ATTEMPTS = 8
// Cap slow-backoff ceiling at 45s instead of 300s (5 minutes) so mobile does
// not remain stuck offline for minutes after brief tunnel drops.
export const SSE_RECONNECT_SLOW_MAX_DELAY_MS = 45_000

export function computeReconnectDelayMs(
    attempt: number,
    randomUnit = 0
): number {
    const normalizedAttempt = Math.max(0, Math.floor(attempt))
    const maxDelay = normalizedAttempt >= SSE_RECONNECT_SLOW_AFTER_ATTEMPTS
        ? SSE_RECONNECT_SLOW_MAX_DELAY_MS
        : SSE_RECONNECT_MAX_DELAY_MS
    const exponentialDelay = normalizedAttempt === 0
        ? 0
        : Math.min(maxDelay, SSE_RECONNECT_BASE_DELAY_MS * (2 ** (normalizedAttempt - 1)))
    const clampedRandom = Math.min(1, Math.max(0, randomUnit))
    const jitter = Math.floor(clampedRandom * (SSE_RECONNECT_JITTER_MS + 1))
    return exponentialDelay + jitter
}

export type VisibilityResumeAction =
    | 'noop'
    | 'reconnect-now-reset-backoff'
    | 'reconnect-stale'
    | 'refresh-sessions-only'

export function decideVisibilityResumeAction(input: {
    visibility: 'visible' | 'hidden'
    reconnectDeferred: boolean
    hasPendingReconnectTimer: boolean
    hasActiveEventSource: boolean
    elapsedSinceActivityMs: number
    hasPendingVisibility404?: boolean
}): VisibilityResumeAction {
    if (input.visibility !== 'visible') {
        return 'noop'
    }
    // A visibility 404 observed while hidden proved the server already evicted
    // the current subscriptionId: reconnect immediately on resume regardless of silence duration.
    if (input.hasPendingVisibility404) {
        return 'reconnect-now-reset-backoff'
    }
    // Deferred hidden retry OR active long backoff timer: wake immediately and reset backoff.
    if (input.reconnectDeferred || (!input.hasActiveEventSource && input.hasPendingReconnectTimer)) {
        return 'reconnect-now-reset-backoff'
    }
    if (!input.hasActiveEventSource) {
        return 'reconnect-now-reset-backoff'
    }
    if (input.elapsedSinceActivityMs >= SSE_VISIBILITY_RESUME_STALE_MS) {
        return 'reconnect-stale'
    }
    if (input.elapsedSinceActivityMs >= SSE_VISIBILITY_LIGHT_REFRESH_MS) {
        return 'refresh-sessions-only'
    }
    return 'noop'
}

export type Visibility404Action = 'ignore' | 'defer-until-visible' | 'reconnect-now'

export function classifyVisibility404Action(input: {
    currentSubscriptionId: string | null
    failedSubscriptionId: string | null | undefined
    visibility: 'visible' | 'hidden'
}): Visibility404Action {
    if (!input.currentSubscriptionId || !input.failedSubscriptionId) {
        return 'ignore'
    }
    if (input.currentSubscriptionId !== input.failedSubscriptionId) {
        return 'ignore'
    }
    if (input.visibility !== 'visible') {
        return 'defer-until-visible'
    }
    return 'reconnect-now'
}

export function shouldReconnectOnVisibility404(input: {
    currentSubscriptionId: string | null
    failedSubscriptionId: string | null | undefined
    visibility: 'visible' | 'hidden'
}): boolean {
    return classifyVisibility404Action(input) === 'reconnect-now'
}

export function decideOnlineEventAction(input: {
    visibility: 'visible' | 'hidden'
    hasActiveEventSource: boolean
    hasPendingReconnectTimer: boolean
    reconnectDeferred: boolean
}): 'noop' | 'reconnect-now-reset-backoff' {
    if (input.visibility !== 'visible') {
        return 'noop'
    }
    if (!input.hasActiveEventSource || input.hasPendingReconnectTimer || input.reconnectDeferred) {
        return 'reconnect-now-reset-backoff'
    }
    return 'noop'
}
