import { describe, expect, it, vi } from 'vitest'
import { BaseLocalLauncher } from './BaseLocalLauncher'
import { MessageQueue2 } from '@/utils/MessageQueue2'

describe('BaseLocalLauncher', () => {
    it('switches to remote (doSwitch) when onQueuedMessage is not provided', async () => {
        const queue = new MessageQueue2<Record<string, never>>(() => 'mode')
        const rpcHandlerManager = { registerHandler: vi.fn() }

        const launcher = new BaseLocalLauncher({
            label: 'test-local',
            failureLabel: 'Test local failed',
            queue,
            rpcHandlerManager,
            launch: (signal) =>
                new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => resolve(), { once: true })
                }),
            sendFailureMessage: vi.fn(),
            recordLocalLaunchFailure: vi.fn()
        })

        const runPromise = launcher.run()
        queue.push('hello from phone', {})

        await expect(runPromise).resolves.toBe('switch')
    })

    it('returns switch before launching when queue already has items and onQueuedMessage is omitted', async () => {
        const queue = new MessageQueue2<Record<string, never>>(() => 'mode')
        queue.push('already-queued', {})
        const launch = vi.fn(async () => {})

        const launcher = new BaseLocalLauncher({
            label: 'test-local',
            failureLabel: 'Test local failed',
            queue,
            rpcHandlerManager: { registerHandler: vi.fn() },
            launch,
            sendFailureMessage: vi.fn(),
            recordLocalLaunchFailure: vi.fn()
        })

        await expect(launcher.run()).resolves.toBe('switch')
        expect(launch).not.toHaveBeenCalled()
    })

    it('keeps running in local mode when onQueuedMessage handles the message', async () => {
        const queue = new MessageQueue2<Record<string, never>>(() => 'mode')
        let finishLocalProcess: (() => void) | null = null
        const handledMessages: string[] = []

        const launcher = new BaseLocalLauncher({
            label: 'test-local',
            failureLabel: 'Test local failed',
            queue,
            rpcHandlerManager: { registerHandler: vi.fn() },
            onQueuedMessage: async () => {
                const shifted = queue.queue.shift()
                if (shifted) {
                    handledMessages.push(shifted.message)
                }
                return 'handled'
            },
            launch: (signal) =>
                new Promise<void>((resolve) => {
                    finishLocalProcess = resolve
                    signal.addEventListener('abort', () => resolve(), { once: true })
                }),
            sendFailureMessage: vi.fn(),
            recordLocalLaunchFailure: vi.fn()
        })

        const runPromise = launcher.run()
        queue.push('stay local', {})
        await Promise.resolve()

        expect(handledMessages).toEqual(['stay local'])
        expect(launcher.control.abortSignal.aborted).toBe(false)

        finishLocalProcess?.()
        await expect(runPromise).resolves.toBe('exit')
    })

    it('switches when onQueuedMessage returns switch', async () => {
        const queue = new MessageQueue2<Record<string, never>>(() => 'mode')

        const launcher = new BaseLocalLauncher({
            label: 'test-local',
            failureLabel: 'Test local failed',
            queue,
            rpcHandlerManager: { registerHandler: vi.fn() },
            onQueuedMessage: async () => 'switch',
            launch: (signal) =>
                new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => resolve(), { once: true })
                }),
            sendFailureMessage: vi.fn(),
            recordLocalLaunchFailure: vi.fn()
        })

        const runPromise = launcher.run()
        queue.push('message with attachment', {})

        await expect(runPromise).resolves.toBe('switch')
    })
})
