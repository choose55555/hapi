import { beforeEach, describe, expect, it, vi } from 'vitest'
const wire = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: Record<string, unknown> }> }))
vi.mock('@/api/authProxy', () => ({
    fetchThroughAuthProxy: async (path: string, init: RequestInit) => {
        wire.calls.push({ path, body: JSON.parse(String(init.body)) })
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
}))
import { ApiClient } from './client'
describe('explicit web send idempotency transport', () => {
    beforeEach(() => { wire.calls = [] })
    it('opts into server dedupe without changing legacy send payloads', async () => {
        const api = new ApiClient('fixture-token')
        await api.sendMessage('s', 'hello', 'old-id')
        await api.sendMessageWithReceipt('s', 'hello', 'stable-id')
        expect(wire.calls[0].body).toEqual({ text: 'hello', localId: 'old-id' })
        expect(wire.calls[1].body).toEqual({ text: 'hello', localId: 'stable-id', deduplicateDelivery: true })
    })
})
