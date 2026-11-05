import { describe, expect, it, vi } from 'vitest'
import { sendWithReceipt, MessageSendFailure } from './workbenchMessageSend'

const empty = () => ({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] })
describe('send acceptance after lost HTTP response', () => {
    it('does not query receipt after successful POST', async () => {
        const read = vi.fn()
        await expect(sendWithReceipt(async () => {}, read, 'same-id')).resolves.toBeUndefined()
        expect(read).not.toHaveBeenCalled()
    })
    it.each(['queued', 'invoked', 'indeterminate', 'dispatching'])('accepts durable %s receipt', async kind => {
        const state = empty() as ReturnType<typeof empty> & { dispatchingLocalIds?: string[] }
        if (kind === 'queued') state.queuedLocalIds = ['same-id'] as never[]
        if (kind === 'indeterminate') state.indeterminateLocalIds = ['same-id'] as never[]
        if (kind === 'dispatching') state.dispatchingLocalIds = ['same-id']
        if (kind === 'invoked') state.invokedLocalMessages = [{ localId: 'same-id', invokedAt: 1 }] as never[]
        await expect(sendWithReceipt(async () => { throw new TypeError('Load failed') }, async () => state, 'same-id'))
            .resolves.toBeUndefined()
    })
    it('does not mistake another message receipt for acceptance', async () => {
        const state = empty()
        state.queuedLocalIds = ['other'] as never[]
        await expect(sendWithReceipt(async () => { throw new TypeError('Load failed') }, async () => state, 'same-id'))
            .rejects.toMatchObject({ message: '未发送，点此重发', confirmedMissing: true })
    })
    it('never reports not sent when receipt lookup also fails', async () => {
        const failure = sendWithReceipt(async () => { throw new TypeError('Load failed') },
            async () => { throw new Error('offline') }, 'same-id')
        await expect(failure).rejects.toBeInstanceOf(MessageSendFailure)
        await expect(failure).rejects.toMatchObject({ message: '暂时无法确认是否送达，点此重试（不会重复发送）', confirmedMissing: false })
    })
})

