import type { MiddlewareHandler } from 'hono'
import { parseAccessToken } from '../utils/accessToken'
import { constantTimeEquals } from '../utils/crypto'

export function createCliCredentialGuard(getState: () => {
    enabled: boolean
    webToken: string
}): MiddlewareHandler {
    return async (c, next) => {
        const state = getState()
        if (!state.enabled || state.webToken.length === 0) {
            await next()
            return
        }
        const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')
        const parsed = match ? parseAccessToken(match[1]) : null
        if (parsed && constantTimeEquals(parsed.baseToken, state.webToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }
        await next()
    }
}
