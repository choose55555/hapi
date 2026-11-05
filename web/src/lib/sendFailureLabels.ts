import { useSyncExternalStore } from 'react'
const labels = new Map<string, string>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function setSendFailureLabel(localId: string, message?: string): void {
    if (message) labels.set(localId, message)
    else labels.delete(localId)
    for (const listener of listeners) listener()
}

export function useSendFailureLabel(localId?: string | null): string | undefined {
    return useSyncExternalStore(subscribe, () => localId ? labels.get(localId) : undefined, () => undefined)
}
