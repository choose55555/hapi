import { logger } from '@/ui/logger'
import { Future } from '@/utils/future'
import { getLocalLaunchExitReason } from '@/agent/localLaunchPolicy'
import type { LocalLaunchExitReason, StartedBy } from '@/agent/localLaunchPolicy'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

type QueueLike = {
    size(): number
    reset(): void
    setOnMessage(callback: ((...args: unknown[]) => void) | null): void
}

type RpcHandlerManagerLike = {
    registerHandler(method: string, handler: () => Promise<void> | void): void
}

export type QueuedMessageOutcome = 'handled' | 'switch' | void

export type LocalLauncherControl = {
    abortSignal: AbortSignal
    requestExit: () => void
    requestSwitch: () => void
    getExitReason: () => LocalLaunchExitReason | null
}

export type LocalLauncherOptions = {
    label: string
    failureLabel: string
    queue: QueueLike
    rpcHandlerManager: RpcHandlerManagerLike
    startedBy?: StartedBy
    startingMode?: 'local' | 'remote'
    launch: (signal: AbortSignal) => Promise<void>
    onLaunchSuccess?: () => Promise<void> | void
    onQueuedMessage?: () => Promise<QueuedMessageOutcome> | QueuedMessageOutcome
    sendFailureMessage: (message: string) => void
    recordLocalLaunchFailure: (message: string, exitReason: LocalLaunchExitReason) => void
    abortLogMessage?: string
    switchLogMessage?: string
}

export class BaseLocalLauncher {
    private exitReason: LocalLaunchExitReason | null = null
    private readonly abortController = new AbortController()
    private readonly exitFuture = new Future<void>()

    private readonly options: LocalLauncherOptions
    constructor(options: LocalLauncherOptions) { this.options = options }

    get control(): LocalLauncherControl {
        return {
            abortSignal: this.abortController.signal,
            requestExit: this.requestExit,
            requestSwitch: this.requestSwitch,
            getExitReason: () => this.exitReason
        }
    }

    async run(): Promise<LocalLaunchExitReason> {
        const {
            label,
            failureLabel,
            queue,
            rpcHandlerManager,
            startedBy,
            startingMode,
            launch,
            onLaunchSuccess,
            onQueuedMessage,
            sendFailureMessage,
            recordLocalLaunchFailure,
            abortLogMessage = 'abort requested',
            switchLogMessage = 'switch requested'
        } = this.options

        try {
            const abortProcess = async () => {
                if (!this.abortController.signal.aborted) {
                    this.abortController.abort()
                }
                await this.exitFuture.promise
            }

            const doAbort = async () => {
                logger.debug(`[${label}]: ${abortLogMessage}`)
                this.setExitReason('switch')
                queue.reset()
                await abortProcess()
            }

            const doSwitch = async () => {
                logger.debug(`[${label}]: ${switchLogMessage}`)
                this.setExitReason('switch')
                await abortProcess()
            }

            const handleQueuedMessage = async () => {
                if (!onQueuedMessage) {
                    await doSwitch()
                    return
                }
                try {
                    const outcome = await onQueuedMessage()
                    if (outcome === 'switch') {
                        await doSwitch()
                    }
                } catch (error) {
                    logger.debug(`[${label}]: onQueuedMessage error`, error)
                }
            }

            rpcHandlerManager.registerHandler(RPC_METHODS.Abort, doAbort)
            rpcHandlerManager.registerHandler(RPC_METHODS.Switch, doSwitch)
            queue.setOnMessage(() => {
                void handleQueuedMessage()
            })

            if (this.exitReason) {
                return this.exitReason
            }

            if (queue.size() > 0 && !onQueuedMessage) {
                return 'switch'
            }

            while (true) {
                if (this.exitReason) {
                    return this.exitReason
                }

                logger.debug(`[${label}]: launch`)
                try {
                    const launchPromise = launch(this.abortController.signal)
                    if (onQueuedMessage && queue.size() > 0) {
                        void handleQueuedMessage()
                    }
                    await launchPromise
                    if (onLaunchSuccess) {
                        await onLaunchSuccess()
                    }

                    if (!this.exitReason) {
                        this.exitReason = 'exit'
                        break
                    }
                } catch (error) {
                    logger.debug(`[${label}]: launch error`, error)
                    const message = error instanceof Error ? error.message : String(error)
                    const failureMessage = `${failureLabel}: ${message}`
                    sendFailureMessage(failureMessage)
                    const failureExitReason = this.exitReason ?? getLocalLaunchExitReason({
                        startedBy,
                        startingMode
                    })
                    recordLocalLaunchFailure(message, failureExitReason)
                    if (!this.exitReason) {
                        this.exitReason = failureExitReason
                    }
                    if (failureExitReason === 'exit') {
                        logger.warn(`[${label}]: ${failureMessage}`)
                    }
                    break
                }
            }
        } finally {
            this.exitFuture.resolve(undefined)
            rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {})
            rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async () => {})
            queue.setOnMessage(null)
        }

        return this.exitReason || 'exit'
    }

    private requestExit = (): void => {
        this.setExitReason('exit')
        if (!this.abortController.signal.aborted) {
            this.abortController.abort()
        }
    }

    private requestSwitch = (): void => {
        this.setExitReason('switch')
        if (!this.abortController.signal.aborted) {
            this.abortController.abort()
        }
    }

    private setExitReason(reason: LocalLaunchExitReason): void {
        if (!this.exitReason) {
            this.exitReason = reason
        }
    }
}
