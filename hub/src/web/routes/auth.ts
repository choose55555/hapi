import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { AuthRequestSchema } from '@hapi/protocol'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

export function createAuthRoutes(jwtSecret: Uint8Array, store: Store, deps: {
    getConfiguration?: typeof getConfiguration
    getOwnerId?: typeof getOrCreateOwnerId
} = {}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const getConfig = deps.getConfiguration ?? getConfiguration
    const getOwnerId = deps.getOwnerId ?? getOrCreateOwnerId

    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = AuthRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const credential = getConfig().workbenchCredential
        const generation = credential?.generation
        let userId: number
        let username: string | undefined
        let firstName: string | undefined
        let lastName: string | undefined
        let namespace: string

        // Access Token authentication (CLI_API_TOKEN)
        if ('accessToken' in parsed.data) {
            const configuration = getConfig()
            const parsedToken = parseAccessToken(parsed.data.accessToken)
            if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
                return c.json({ error: 'Invalid access token' }, 401)
            }
            if (credential?.expired) {
                return c.json({ error: 'credential_expired' }, 401)
            }
            userId = await getOwnerId()
            firstName = 'Web User'
            namespace = parsedToken.namespace
        } else {
            const configuration = getConfig()
            if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
                return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
            }

            // Telegram initData authentication
            const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
            if (!result.ok) {
                return c.json({ error: result.error }, 401)
            }

            const telegramUserId = String(result.user.id)
            const storedUser = store.users.getUser('telegram', telegramUserId)
            if (!storedUser) {
                return c.json({ error: 'not_bound' }, 401)
            }

            userId = await getOwnerId()
            username = result.user.username
            firstName = result.user.first_name
            lastName = result.user.last_name
            namespace = storedUser.namespace
        }

        if (credential && !credential.accepts(generation)) {
            return c.json({ error: 'credential_expired' }, 401)
        }
        const token = await new SignJWT({ uid: userId, ns: namespace, ...(credential ? { cg: generation } : {}) })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime(credential ? credential.jwtExpiresAt() : '4h')
            .sign(jwtSecret)

        return c.json({
            token,
            user: {
                id: userId,
                username,
                firstName,
                lastName
            }
        })
    })

    return app
}
