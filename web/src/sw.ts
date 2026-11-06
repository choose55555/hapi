/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import {
    cleanupExpiredShareTransfers,
    ingestShareRequest,
    putShareTransfer,
} from './lib/shareTransfer'
import { shareTargetPathname } from './lib/sharePath'
import { cacheOkResponsesOnly } from './lib/swCachePolicy'

const sharePath = shareTargetPathname()

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<string | { url: string; revision?: string }>
}

type PushPayload = {
    title: string
    body?: string
    icon?: string
    badge?: string
    tag?: string
    data?: {
        type?: string
        sessionId?: string
        url?: string
    }
}

// Capture this when the worker starts, before registration.active becomes this worker.
// Initial installation needs no reload. Updates must replace the already-loaded
// old JavaScript as well as its controller (claim alone does not do that).
// Re-evaluating after an install/activate process restart still sees an active
// registration, so a restart cannot silently lose the update reload flag.
const replacingWorker = self.registration.active !== null
self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting())
})

precacheAndRoute(self.__WB_MANIFEST)
// Workbox also removes obsolete entries in its current precache on activation.
// This removes incompatible precaches left by older Workbox versions only;
// share transfers and API caches are intentionally untouched.
cleanupOutdatedCaches()

const scopeUrl = new URL(self.registration.scope)
const assetsPath = new URL('assets/', scopeUrl).pathname
registerRoute(
    ({ url }) => url.origin === scopeUrl.origin
        && url.pathname.startsWith(assetsPath)
        && /\.(?:js|css|woff2?|ttf|otf|png|ico|svg)$/i.test(url.pathname),
    new CacheFirst({
        cacheName: 'hapi-static-v1',
        plugins: [
            cacheOkResponsesOnly,
            new ExpirationPlugin({ maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 30 })
        ]
    })
)

// A refreshed tab must receive the newly installed HTML, including deep links
// and installations under VITE_BASE_URL. Never turn an API request into HTML.
registerRoute(
    ({ request, url }) => request.mode === 'navigate'
        && url.origin === scopeUrl.origin
        && url.pathname.startsWith(scopeUrl.pathname)
        && !/^(?:api|cli|socket\.io|health)(?:\/|$)/.test(url.pathname.slice(scopeUrl.pathname.length)),
    createHandlerBoundToURL('index.html')
)

registerRoute(
    ({ url }) => url.pathname === '/api/sessions',
    new NetworkFirst({
        cacheName: 'api-sessions',
        networkTimeoutSeconds: 10,
        plugins: [
            cacheOkResponsesOnly,
            new ExpirationPlugin({
                maxEntries: 10,
                maxAgeSeconds: 60 * 5
            })
        ]
    })
)

registerRoute(
    ({ url }) => /^\/api\/sessions\/[^/]+$/.test(url.pathname),
    new NetworkFirst({
        cacheName: 'api-session-detail',
        networkTimeoutSeconds: 10,
        plugins: [
            cacheOkResponsesOnly,
            new ExpirationPlugin({
                maxEntries: 20,
                maxAgeSeconds: 60 * 5
            })
        ]
    })
)

registerRoute(
    ({ url }) => url.pathname === '/api/machines',
    new NetworkFirst({
        cacheName: 'api-machines',
        networkTimeoutSeconds: 10,
        plugins: [
            cacheOkResponsesOnly,
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 10
            })
        ]
    })
)

registerRoute(
    /^https:\/\/cdn\.socket\.io\/.*/,
    new CacheFirst({
        cacheName: 'cdn-socketio',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 30
            })
        ]
    })
)

registerRoute(
    /^https:\/\/telegram\.org\/.*/,
    new CacheFirst({
        cacheName: 'cdn-telegram',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 7
            })
        ]
    })
)

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting()
    }
})

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        await self.clients.claim()
        if (!replacingWorker) return
        const windows = await self.clients.matchAll({ type: 'window' })
        await Promise.all(windows.map(async (client) => {
            const url = new URL(client.url)
            if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) return
            try {
                // Retain deep links, query state and fragments; only reload once
                // per activation. A closed tab must not fail the whole update.
                await client.navigate(client.url)
            } catch (error) {
                console.warn('Updated page reload failed', error)
            }
        }))
    })())
})

self.addEventListener('push', (event) => {
    const payload = event.data?.json() as PushPayload | undefined
    if (!payload) {
        return
    }

    const title = payload.title || 'HAPI'
    const body = payload.body ?? ''
    const icon = payload.icon ?? '/pwa-192x192.png'
    const badge = payload.badge ?? '/pwa-64x64.png'
    const data = payload.data
    const tag = payload.tag

    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            badge,
            data,
            tag
        })
    )
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: string } | undefined
    const url = data?.url ?? '/'
    event.waitUntil(self.clients.openWindow(url))
})

// Web Share Target — manifest declares POST /share, Android Chrome posts a
// multipart form with title/text/url/files. Stash in IDB so the SPA route
// can read it after the 303 redirect (which converts POST -> GET).
self.addEventListener('fetch', (event) => {
    const request = event.request
    if (request.method !== 'POST') return
    const url = new URL(request.url)
    if (url.pathname !== sharePath) return

    event.respondWith(handleShareTarget(request))
})

async function handleShareTarget(request: Request): Promise<Response> {
    // Resolve to absolute URLs because Response.redirect throws on relative
    // input per the Fetch spec; Chrome currently tolerates relative paths
    // but the SW spec is explicit and the cost of resolving is one line.
    const origin = self.location.origin
    try {
        const { redirectTo } = await ingestShareRequest(request, { put: putShareTransfer })
        return Response.redirect(new URL(redirectTo, origin).toString(), 303)
    } catch (error) {
        // Surface a minimal page if IDB write fails — don't 5xx silently or
        // the user gets a Chrome error sheet instead of useful UI.
        console.error('share-target ingest failed', error)
        return Response.redirect(new URL(`${sharePath}?error=ingest`, origin).toString(), 303)
    }
}

// Best-effort GC for stale share transfers (TTL-only — never blocks
// anything else). 1h TTL is set in shareTransfer.ts.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        cleanupExpiredShareTransfers().catch((error) => {
            console.warn('share-transfer cleanup failed', error)
        })
    )
})
