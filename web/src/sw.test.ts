import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    precache: vi.fn(), cleanup: vi.fn(), route: vi.fn(),
    strategy: vi.fn(function (this: { options: unknown }, options: unknown) { this.options = options }),
}))
vi.mock('workbox-precaching', () => ({
    precacheAndRoute: mocks.precache, cleanupOutdatedCaches: mocks.cleanup,
    createHandlerBoundToURL: vi.fn(() => () => new Response('shell')),
}))
vi.mock('workbox-routing', () => ({ registerRoute: mocks.route }))
vi.mock('workbox-strategies', () => ({ CacheFirst: mocks.strategy, NetworkFirst: mocks.strategy }))
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: class { constructor(public options: unknown) {} } }))
vi.mock('./lib/shareTransfer', () => ({
    cleanupExpiredShareTransfers: vi.fn(async () => {}),
    ingestShareRequest: vi.fn(), putShareTransfer: vi.fn(),
}))
vi.mock('./lib/sharePath', () => ({ shareTargetPathname: () => '/app/share' }))

type Listener = (event: { waitUntil: (promise: Promise<unknown>) => void; data?: unknown }) => void
afterEach(() => vi.unstubAllGlobals())
let listeners: Map<string, Listener[]>
let worker: {
    __WB_MANIFEST: unknown[]
    registration: { active: object | null; scope: string }
    location: { origin: string }
    skipWaiting: ReturnType<typeof vi.fn>
    clients: { claim: ReturnType<typeof vi.fn>; matchAll: ReturnType<typeof vi.fn> }
    addEventListener: (name: string, listener: Listener) => void
}

async function dispatch(name: string, data?: unknown) {
    const promises: Promise<unknown>[] = []
    for (const listener of listeners.get(name) ?? []) {
        listener({ data, waitUntil: promise => promises.push(promise) })
    }
    await Promise.all(promises)
}

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listeners = new Map()
    worker = {
        __WB_MANIFEST: [{ url: 'index.html', revision: 'v7' }],
        registration: { active: {}, scope: 'https://hapi.test/app/' },
        location: { origin: 'https://hapi.test' },
        skipWaiting: vi.fn(async () => {}),
        clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => []) },
        addEventListener: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
    }
    vi.stubGlobal('self', worker)
})

describe('v7 service worker', () => {
    it('skips waiting on install, claims clients and cleans obsolete precaches', async () => {
        await import('./sw')
        await dispatch('install')
        await dispatch('activate')
        expect(worker.skipWaiting).toHaveBeenCalledTimes(1)
        expect(worker.clients.claim).toHaveBeenCalledTimes(1)
        expect(mocks.cleanup).toHaveBeenCalledTimes(1)
        expect(mocks.precache).toHaveBeenCalledWith(worker.__WB_MANIFEST)
    })

    it('reloads old pages after claiming, preserving path, query and hash; isolates scope', async () => {
        const url = 'https://hapi.test/app/sessions?id=42#bottom'
        const navigate = vi.fn(async () => null)
        const unrelated = vi.fn()
        worker.clients.matchAll.mockImplementation(async () => {
            expect(worker.clients.claim).toHaveBeenCalledTimes(1)
            return [
                { url, navigate },
                { url: 'https://hapi.test/other/', navigate: unrelated },
                { url: 'https://other.test/app/', navigate: unrelated },
            ]
        })
        await import('./sw')
        await dispatch('install')
        await dispatch('activate')
        expect(navigate).toHaveBeenCalledWith(url)
        expect(unrelated).not.toHaveBeenCalled()
    })

    it('does not reload on first installation or fail activation when a tab has closed', async () => {
        worker.registration.active = null
        await import('./sw')
        await dispatch('install')
        await dispatch('activate')
        expect(worker.clients.matchAll).not.toHaveBeenCalled()

        vi.resetModules()
        listeners.clear()
        worker.registration.active = {}
        worker.clients.matchAll.mockResolvedValue([
            { url: 'https://hapi.test/app/', navigate: vi.fn(async () => { throw new Error('tab closed') }) },
        ])
        await import('./sw')
        await dispatch('install')
        await expect(dispatch('activate')).resolves.toBeUndefined()
    })

    it('keeps the manual update message working', async () => {
        await import('./sw')
        await dispatch('message', { type: 'SKIP_WAITING' })
        expect(worker.skipWaiting).toHaveBeenCalledTimes(1)
    })

    it('caches lazy assets on demand only for the local app and serves shell navigations', async () => {
        await import('./sw')
        const callbacks = mocks.route.mock.calls.filter(([match]) => typeof match === 'function')
        const assetMatch = callbacks.map(([match]) => match).find(match =>
            match({ url: new URL('https://hapi.test/app/assets/vendor-terminal-abc.js'), request: { mode: 'cors' } }))
        expect(assetMatch).toBeDefined()
        for (const path of ['vendor-voice-a.js', 'vendor-assistant-b.js', 'fonts/KaTeX_Main.woff2', 'lazy.css']) {
            expect(assetMatch({ url: new URL('https://hapi.test/app/assets/' + path) })).toBe(true)
        }
        for (const url of ['https://other.test/app/assets/a.js', 'https://hapi.test/other/assets/a.js', 'https://hapi.test/app/api/sessions']) {
            expect(assetMatch({ url: new URL(url) })).toBe(false)
        }
        // No catch-all navigation route: server paths and deep links reach the hub.
        for (const path of ['sessions', 'health', 'api/sessions', 'cli/x']) {
            const hits = callbacks.map(([match]) => match).filter(match => {
                try { return match({ url: new URL('https://hapi.test/app/' + path), request: { mode: 'navigate' } }) === true }
                catch { return false }
            })
            expect(hits).toEqual([])
        }
    })
})
