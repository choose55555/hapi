import { describe, expect, it } from 'bun:test'
import { MessageService } from './messageService'
import { Store } from '../store'
import type { Server } from 'socket.io'
import type { EventPublisher } from './eventPublisher'

describe('POST retry acceptance is idempotent', () => {
    for (const consumed of [false, true]) {
        it('stores and dispatches once, consumed=' + consumed, async () => {
            const store = new Store(':memory:')
            try {
                const session = store.sessions.getOrCreateSession('retry', { path: '/tmp/retry' }, null, 'default')
                const updates: unknown[] = []
                const io = { of: () => ({ to: () => ({ emit: (_event: string, data: unknown) => updates.push(data) }) }) } as unknown as Server
                const publisher = { emit: () => {} } as unknown as EventPublisher
                const service = new MessageService(store, io, publisher)
                const first = await service.sendMessage(session.id, { text: 'only once', localId: 'stable-id', deduplicateDelivery: true })
                if (consumed) store.messages.markMessagesInvoked(session.id, ['stable-id'], Date.now())
                const second = await service.sendMessage(session.id, { text: 'only once', localId: 'stable-id', deduplicateDelivery: true })
                expect(second).toEqual(first)
                expect(store.messages.getMessages(session.id, 10)).toHaveLength(1)
                expect(updates).toHaveLength(1)
                // Receipt survives service reconstruction (no in-memory dedupe).
                const restarted = new MessageService(store, io, publisher)
                await restarted.sendMessage(session.id, { text: 'only once', localId: 'stable-id', deduplicateDelivery: true })
                expect(updates).toHaveLength(1)
                // A deliberately new id is a new send, even for the same text.
                await restarted.sendMessage(session.id, { text: 'only once', localId: 'another-id' })
                expect(updates).toHaveLength(2)
            } finally {
                store.close()
            }
        })
    }
})
