import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import type { WorkbenchCredential } from '../../config/workbenchCredential'

export function createWorkbenchCredentialRoutes(credential: WorkbenchCredential): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/workbench/credential', c => {
        c.header('Cache-Control', 'no-store')
        return c.json({ expiresAt: credential.expiresAt })
    })
    app.post('/workbench/credential/renew', async c => {
        c.header('Cache-Control', 'no-store')
        try {
            const result = await credential.renew(c.get('credentialGeneration'))
            const namespace = c.get('namespace')
            return c.json({
                ...result,
                accessToken: namespace === 'default' ? result.accessToken : `${result.accessToken}:${namespace}`
            })
        } catch (error) {
            if (error instanceof Error && error.message === 'credential_expired') {
                return c.json({ error: 'credential_expired' }, 401)
            }
            throw error
        }
    })
    return app
}
