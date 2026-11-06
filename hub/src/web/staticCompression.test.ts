import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { gunzipSync } from 'node:zlib'
import { staticCompression } from './server'

const body = 'const hello = "HAPI";\n'.repeat(400)
function appFor(type: string, headers: Record<string, string> = {}) {
    const app = new Hono()
    app.use('*', staticCompression)
    app.get('*', () => new Response(body, { headers: { 'Content-Type': type, ...headers } }))
    return app
}

describe('static gzip for filesystem and embedded response bodies', () => {
    for (const [path, type] of [
        ['/', 'text/html; charset=utf-8'],
        ['/sessions/42', 'text/html'],
        ['/assets/main.js', 'text/javascript'],
        ['/assets/main.css', 'text/css'],
        ['/manifest.webmanifest', 'application/manifest+json'],
    ]) {
        it('compresses and round-trips ' + path, async () => {
            const response = await appFor(type).request(path, { headers: { 'Accept-Encoding': 'gzip' } })
            expect(response.headers.get('Content-Encoding')).toBe('gzip')
            expect(response.headers.get('Vary')).toContain('Accept-Encoding')
            expect(response.headers.has('Content-Length')).toBe(false)
            expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(body)
        })
    }

    for (const encoding of ['', 'br', 'gzip;q=0', '*;q=1, gzip;q=0']) {
        it('honors refusal or absence: ' + encoding, async () => {
            const response = await appFor('text/javascript').request('/assets/main.js', { headers: { 'Accept-Encoding': encoding } })
            expect(response.headers.has('Content-Encoding')).toBe(false)
            expect(response.headers.get('Vary')).toContain('Accept-Encoding')
            expect(await response.text()).toBe(body)
        })
    }

    for (const encoding of ['gzip;q=0.5', '*;q=1', '*;q=0, gzip;q=1']) {
        it('honors accepted q-values: ' + encoding, async () => {
            const response = await appFor('text/html').request('/', { headers: { 'Accept-Encoding': encoding } })
            expect(response.headers.get('Content-Encoding')).toBe('gzip')
            await response.arrayBuffer()
        })
    }

    for (const type of ['image/png', 'image/svg+xml', 'font/woff2', 'font/ttf', 'application/octet-stream']) {
        it('leaves binary/image/font bytes unchanged: ' + type, async () => {
            const response = await appFor(type).request('/assets/file', { headers: { 'Accept-Encoding': 'gzip' } })
            expect(response.headers.has('Content-Encoding')).toBe(false)
            expect(await response.text()).toBe(body)
        })
    }

    it('preserves existing Vary and avoids double compression', async () => {
        const response = await appFor('text/css', { Vary: 'Origin', 'Content-Encoding': 'br' })
            .request('/assets/a.css', { headers: { 'Accept-Encoding': 'gzip' } })
        expect(response.headers.get('Content-Encoding')).toBe('br')
        expect(response.headers.get('Vary')).toContain('Origin')
        expect(await response.text()).toBe(body)
    })

    it('merges Vary on identity and gzip responses', async () => {
        for (const encoding of ['gzip', 'gzip;q=0']) {
            const response = await appFor('text/html', { Vary: 'Origin' }).request('/', { headers: { 'Accept-Encoding': encoding } })
            expect(response.headers.get('Vary')).toContain('Origin')
            expect(response.headers.get('Vary')).toContain('Accept-Encoding')
            await response.arrayBuffer()
        }
    })

    it('does not transform partial, HEAD, or API responses', async () => {
        const app = new Hono()
        app.use('*', staticCompression)
        app.get('/assets/part.js', () => new Response(body, { status: 206, headers: { 'Content-Type': 'text/javascript', 'Content-Range': 'bytes 0-99/100' } }))
        app.get('/api/test', c => c.json({ value: body }))
        app.get('/', c => c.html(body))
        for (const [path, method] of [['/assets/part.js', 'GET'], ['/api/test', 'GET'], ['/', 'HEAD']]) {
            const response = await app.request(path, { method, headers: { 'Accept-Encoding': 'gzip' } })
            expect(response.headers.has('Content-Encoding')).toBe(false)
        }
    })
})
