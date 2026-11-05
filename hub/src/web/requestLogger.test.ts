import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { requestLogger } from './requestLogger'

describe('HTTP access log privacy', () => {
    it.each(['/api/events?token=secret.jwt&other=private', '/api/events?token=one&token=two', '/health'])(
        'logs only the path while preserving the request: %s', async path => {
            const lines: string[] = []
            const app = new Hono()
            app.use('*', requestLogger(line => lines.push(line)))
            app.get('*', c => c.json({ token: c.req.query('token') ?? null }))
            const response = await app.request(path)
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ token: new URL(path, 'http://localhost').searchParams.get('token') })
            expect(lines).toHaveLength(2)
            expect(lines[0]).toBe('<-- GET ' + path.split('?')[0])
            expect(lines[1].startsWith('--> GET ' + path.split('?')[0] + ' 200 ')).toBe(true)
            expect(lines[1]).toMatch(/ 200 \d+ms$/)
            expect(lines.join('\n')).not.toContain('?')
            expect(lines.join('\n')).not.toContain('secret.jwt')
            expect(lines.join('\n')).not.toContain('private')
        })
    it('keeps error status visible without query data', async () => {
        const lines: string[] = []
        const app = new Hono()
        app.use('*', requestLogger(line => lines.push(line)))
        app.get('/api/events', c => c.text('Unauthorized', 401))
        expect((await app.request('/api/events?token=secret')).status).toBe(401)
        expect(lines[1]).toMatch(/^--> GET \/api\/events 401 \d+ms$/)
    })
})
