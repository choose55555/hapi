import type { QueuedStateResponse } from '@hapi/protocol/apiTypes'

export class MessageSendFailure extends TypeError {
    constructor(public readonly confirmedMissing: boolean) {
        super(confirmedMissing
            ? '未发送，点此重发'
            : '暂时无法确认是否送达，点此重试（不会重复发送）')
        this.name = 'MessageSendFailure'
    }
}

/** An HTTP transport error is NOT proof of non-delivery. Read the durable
 * receipt by the same id; never mint a new id for a retry of this send.
 */
export async function sendWithReceipt(
    post: () => Promise<void>,
    receipt: () => Promise<QueuedStateResponse>,
    localId: string,
): Promise<void> {
    try {
        await post()
        return
    } catch (error) {
        // Preserve HTTP status/code and non-fetch errors for existing callers.
        // Safari's raw TypeError is the confusing send error we translate.
        const fetchFailure = error instanceof TypeError
            && /load failed|failed to fetch|networkerror/i.test(error.message)
        let state: QueuedStateResponse
        try {
            state = await receipt()
        } catch {
            if (!fetchFailure) throw error
            throw new MessageSendFailure(false)
        }
        if (state.queuedLocalIds.includes(localId)
            || state.indeterminateLocalIds?.includes(localId)
            || state.dispatchingLocalIds?.includes(localId)
            || state.invokedLocalMessages.some(row => row.localId === localId)) return
        if (!fetchFailure) throw error
        throw new MessageSendFailure(true)
    }
}
