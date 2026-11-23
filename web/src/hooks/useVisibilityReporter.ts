import { useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import { createVisibilityReporter } from './visibilityReporter'

type VisibilityState = 'visible' | 'hidden'

function getVisibilityState(): VisibilityState {
    if (typeof document === 'undefined') {
        return 'hidden'
    }
    return document.visibilityState === 'visible' ? 'visible' : 'hidden'
}

export function useVisibilityReporter(options: {
    api: ApiClient | null
    subscriptionId: string | null
    enabled?: boolean
    onSubscriptionNotFound?: (failedSubscriptionId: string | null | undefined) => boolean
}): void {
    const lastStateRef = useRef<VisibilityState | null>(null)
    const lastSubscriptionRef = useRef<string | null>(null)
    const pendingStateRef = useRef<VisibilityState | null>(null)
    const inFlightRef = useRef(false)
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const onSubscriptionNotFoundRef = useRef(options.onSubscriptionNotFound)
    onSubscriptionNotFoundRef.current = options.onSubscriptionNotFound

    const clearRetry = () => {
        if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current)
            retryTimerRef.current = null
        }
    }

    useEffect(() => {
        if (options.enabled === false) {
            clearRetry()
            return
        }
        if (!options.api || !options.subscriptionId) {
            lastStateRef.current = null
            lastSubscriptionRef.current = options.subscriptionId ?? null
            pendingStateRef.current = null
            clearRetry()
            return
        }

        const api = options.api
        const subscriptionId = options.subscriptionId
        if (lastSubscriptionRef.current !== subscriptionId) {
            lastSubscriptionRef.current = subscriptionId
            lastStateRef.current = null
            pendingStateRef.current = null
            clearRetry()
        }

        const reportToServer = createVisibilityReporter({
            getCurrentSubscriptionId: () => lastSubscriptionRef.current,
            postVisibility: (subId, visible) => api.setVisibility({
                subscriptionId: subId,
                visibility: visible ? 'visible' : 'hidden'
            }),
            reportVisibility404: (failedId) => onSubscriptionNotFoundRef.current?.(failedId) === true
        })

        const flush = () => {
            if (lastSubscriptionRef.current !== subscriptionId) {
                return
            }
            const desired = pendingStateRef.current
            if (!desired) {
                return
            }
            if (inFlightRef.current) {
                return
            }
            if (retryTimerRef.current) {
                return
            }
            if (lastStateRef.current === desired) {
                pendingStateRef.current = null
                return
            }

            inFlightRef.current = true
            let shouldStopFlush = false
            const activeSubscription = subscriptionId
            void reportToServer(desired === 'visible').then((result) => {
                if (lastSubscriptionRef.current !== activeSubscription) {
                    return
                }
                if (result.outcome === 'ok') {
                    lastStateRef.current = desired
                    if (pendingStateRef.current === desired) {
                        pendingStateRef.current = null
                    }
                    clearRetry()
                    return
                }
                if (result.outcome === 'deferred-404-not-recovered') {
                    // Server already evicted this subscription while hidden (or no recovery callback):
                    // clear lastStateRef so returning to foreground can still report/recover,
                    // and stop 2s background retries against the dead subscription.
                    lastStateRef.current = null
                    shouldStopFlush = true
                    clearRetry()
                    return
                }
                if (
                    result.outcome === 'reconnected-404'
                    || result.outcome === 'duplicate-404-suppressed'
                    || result.outcome === 'stale-404-ignored'
                    || result.outcome === 'skipped-no-subscription'
                ) {
                    shouldStopFlush = true
                    clearRetry()
                    return
                }
                shouldStopFlush = true
                console.error('Failed to update visibility:', result.error ?? result.status)
                if (!retryTimerRef.current) {
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = null
                        flush()
                    }, 2000)
                }
            }).finally(() => {
                if (lastSubscriptionRef.current !== activeSubscription) {
                    return
                }
                inFlightRef.current = false
                if (shouldStopFlush || retryTimerRef.current) {
                    return
                }
                if (pendingStateRef.current && pendingStateRef.current !== lastStateRef.current) {
                    flush()
                }
            })
        }

        const report = () => {
            const state = getVisibilityState()
            pendingStateRef.current = state
            flush()
        }

        report()
        document.addEventListener('visibilitychange', report)
        return () => {
            document.removeEventListener('visibilitychange', report)
            clearRetry()
            inFlightRef.current = false
        }
    }, [options.api, options.enabled, options.subscriptionId])
}
