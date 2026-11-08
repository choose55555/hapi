function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object'
}

function hasTranscriptEchoFlag(meta: unknown): boolean {
    return isObject(meta) && meta.isTranscriptEcho === true
}

function isEchoRecord(value: unknown): boolean {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value && hasTranscriptEchoFlag(value.meta)
}

/**
 * True only for the CLI transcript row that repeats a phone message already
 * stored from the webapp. Computer-typed input does not carry this flag.
 * The lookup follows the same envelope shapes as unwrapRoleWrappedRecordEnvelope.
 */
export function isTranscriptEchoContent(content: unknown): boolean {
    if (!isObject(content)) return false
    if (isEchoRecord(content)) return true
    if (isEchoRecord(content.message)) return true
    if (isObject(content.data) && isEchoRecord(content.data.message)) return true
    if (isObject(content.payload) && isEchoRecord(content.payload.message)) return true
    return false
}
