import type { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from '../loop'
import { normalizeLineEndings, type ConsoleMessageInjector } from './consoleInject'

type Client = {
    notePendingHubPromptEcho(text: string, ids: readonly string[]): void
    discardPendingHubPromptEcho(localId: string): void
    sendSessionEvent(event: { type: 'message'; message: string }): void
}

const LOCAL_UNSUPPORTED_NOTICE = '此类消息（$ 技能、附件、内部消息）在本地窗口不支持，请在电脑上发；窗口未重开'

export function requiresRemoteSwitch(item: { message: unknown; mode: EnhancedMode; internal?: boolean }): boolean {
    return typeof item.message !== 'string' || item.mode.hasAttachments === true
        || item.mode.nonTextContent === true || item.internal === true
        || /^\s*\u0024/.test(item.message)
}

export function createLocalMessageDrain(options: {
    queue: MessageQueue2<EnhancedMode>
    injector: Pick<ConsoleMessageInjector, 'enqueueMessage'>
    client: Client
    signal: AbortSignal
    isExited: () => boolean
    isReady: () => boolean
    isPermissionBlocked: () => boolean
    timeoutMs?: number
    now?: () => number
    pause?: () => Promise<void>
    platform?: NodeJS.Platform
}): () => Promise<'handled' | 'switch'> {
    let active: Promise<'handled' | 'switch'> | null = null
    let halted = false
    const now = options.now ?? Date.now
    const windowsLocal = (options.platform ?? process.platform) === 'win32'
    const pause = options.pause ?? (() => new Promise<void>(resolve => {
        if (options.signal.aborted) { resolve(); return }
        const done = () => { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, 50)
        options.signal.addEventListener('abort', done, { once: true })
    }))
    const notify = (id: string | undefined, status: string) => options.client.sendSessionEvent({
        type: 'message', message: '[local-console ' + (id ?? 'no-localId') + '] ' + status
    })
    const rejectUnsupported = (front: { localId?: string }): boolean => {
        const id = front.localId
        if (id) {
            const reservation = options.queue.takeByLocalId(id)
            if (!reservation) {
                notify(id, LOCAL_UNSUPPORTED_NOTICE)
                return false
            }
            if (reservation.state !== 'cancelled') {
                options.queue.cancelByLocalId(id)
            }
            notify(id, LOCAL_UNSUPPORTED_NOTICE)
            return true
        }
        const removed = options.queue.removeItemsMatching(item => item === front)
        notify(undefined, LOCAL_UNSUPPORTED_NOTICE)
        return removed > 0
    }
    return () => {
        if (active) return active
        active = (async (): Promise<'handled' | 'switch'> => {
            while (!halted && options.queue.size() > 0) {
                const front = options.queue.queue[0]
                if (!front) return 'handled'
                if (requiresRemoteSwitch(front) || (!windowsLocal && typeof front.message === 'string' && /^\s*\//.test(front.message))) {
                    if (!windowsLocal) return 'switch'
                    if (!rejectUnsupported(front)) return 'handled'
                    continue
                }
                // Existing reservation/cancel protocol requires a stable localId.
                // Keep id-less rows queued rather than inventing a hub identity.
                if (!front.localId) {
                    notify(undefined, 'Message retained: localId required for safe local delivery.')
                    return 'handled'
                }
                const reservation = options.queue.takeByLocalId(front.localId)
                if (!reservation) return 'handled'
                const id = front.localId
                const deadline = now() + (options.timeoutMs ?? 30000)
                let registered = false
                let dispatchStarted = false
                try {
                    if (!options.isReady() || options.isPermissionBlocked()) {
                        notify(id, 'Waiting for native input readiness / tool completion; message retained.')
                    }
                    while (!options.signal.aborted && !options.isExited()
                        && reservation.state !== 'cancelled'
                        && (!options.isReady() || options.isPermissionBlocked()) && now() < deadline) {
                        await pause()
                    }
                    if (reservation.state === 'cancelled' || options.signal.aborted || options.isExited()) {
                        options.queue.restoreReservation(reservation)
                        notify(id, 'aborted/cancelled before delivery; no console write.')
                        return 'handled'
                    }
                    if (!options.isReady() || options.isPermissionBlocked()) {
                        options.queue.restoreReservation(reservation)
                        notify(id, 'Readiness timeout: message restored; no write and no automatic mode switch.')
                        return 'handled'
                    }
                    const text = normalizeLineEndings(front.message)
                    const result = await options.injector.enqueueMessage(text, () => {
                        if (options.signal.aborted || options.isExited() || !options.isReady()
                            || options.isPermissionBlocked()
                            || !options.queue.beginReservationDispatch(reservation)) return false
                        dispatchStarted = true
                        // Synchronous registration precedes the first native write.
                        options.client.notePendingHubPromptEcho(text, [id])
                        registered = true
                        return true
                    }, {
                        signal: options.signal,
                        isCancelled: () => reservation.state === 'cancelled',
                        permissionWaitTimeoutMs: options.timeoutMs,
                        now: options.now,
                        pause: options.pause
                    })
                    if (result.ok) {
                        if (options.queue.commitReservation(reservation)) {
                            options.queue.onBatchConsumed?.([id])
                        }
                    } else if (result.writeState === 'zero') {
                        if (registered) options.client.discardPendingHubPromptEcho(id)
                        options.queue.restoreReservation(reservation)
                        notify(id, result.reason + ': zero write; restored unless explicitly cancelled. ' + result.message)
                        return 'handled'
                    } else {
                        options.queue.markReservationIndeterminate(reservation)
                        notify(id, result.reason + ': result uncertain; do not resend automatically. ' + result.message)
                        halted = true
                        return 'handled'
                    }
                } catch (error) {
                    // Exceptions after dispatch begins cannot prove zero native side effects.
                    if (dispatchStarted) {
                        options.queue.markReservationIndeterminate(reservation)
                        notify(id, 'Result uncertain; delivery stopped. ' + String(error))
                        halted = true
                    } else {
                        if (registered) options.client.discardPendingHubPromptEcho(id)
                        options.queue.restoreReservation(reservation)
                        notify(id, 'No dispatch; message restored. ' + String(error))
                    }
                    return 'handled'
                }
            }
            return 'handled'
        })().finally(() => { active = null })
        return active
    }
}
