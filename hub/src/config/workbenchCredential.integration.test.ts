import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { SignJWT, decodeJwt } from 'jose'
import { cliLongTermTokenAllowed, WorkbenchCredential, startCredentialReminderChecks } from './workbenchCredential'
import { readSettingsOrThrow, updateSettings } from './settings'
import { createAuthMiddleware, type WebAppEnv } from '../web/middleware/auth'
import { createWorkbenchCredentialRoutes } from '../web/routes/workbenchCredential'
import { verifyTerminalJwt } from '../socket/server'
import { acquireCredentialLease } from './workbenchCredentialLease'
import { createAuthRoutes } from '../web/routes/auth'
import { createBindRoutes } from '../web/routes/bind'
import { createCliCredentialGuard } from '../web/cliCredentialGuard'
import { bindCredentialDisconnect, disconnectCredentialClients } from '../web/credentialDisconnect'
import { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { getConfiguration } from '../configuration'
import type { Store } from '../store'

const directories: string[] = []
afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-credential-test-'))
    directories.push(directory)
    const settingsFile = join(directory, 'settings.json')
    let now = 1_800_000_000_000
    const cliToken = 'test-only-cli-token'
    let webToken = ''
    await updateSettings(settingsFile, settings => ({
        settings: { ...settings, cliApiToken: cliToken, publicUrl: 'http://localhost' }, result: undefined
    }))
    const credential = new WorkbenchCredential(30 * 86_400_000, settingsFile, token => { webToken = token }, () => now)
    await credential.initialize()
    return {
        directory, settingsFile, credential, cliToken,
        getWebToken: () => webToken,
        getToken: () => webToken,
        setNow: (value: number) => { now = value }
    }
}

describe('workbench credential persistence and actual HTTP/socket JWT checks', () => {
    test('live connections are invalidated at expiry and long timers are bounded', async () => {
        const f = await fixture()
        const pending: Array<{ delay: number; callback: () => void }> = []
        let invalidated = 0
        f.credential.onRotate(() => { invalidated++ })
        const stop = f.credential.watchExpiry((delay, callback) => {
            pending.push({ delay, callback })
            return () => {}
        })
        expect(pending[0]!.delay).toBe(2_147_483_647)
        f.setNow(f.credential.expiresAt)
        pending[0]!.callback()
        expect(invalidated).toBe(1)
        stop()
    })
    test('reminder checks at startup and hourly, cancels on stop, stays dormant when disabled', async () => {
        const f = await fixture()
        const callbacks: Array<() => void> = []
        const delays: number[] = []
        let stopped = false
        let sends = 0
        const timers = { every: (callback: () => void, milliseconds: number) => {
            callbacks.push(callback)
            delays.push(milliseconds)
            return () => { stopped = true }
        } }
        await startCredentialReminderChecks(null, async () => { sends++; return true }, timers)
        expect(callbacks).toHaveLength(0)
        const stop = await startCredentialReminderChecks(f.credential, async () => { sends++; return true }, timers)
        expect(sends).toBe(0)
        expect(delays).toEqual([3_600_000])
        f.setNow(f.credential.expiresAt - 3_600_000)
        callbacks[0]!()
        // checkReminder serializes with the scheduled callback; waiting for a
        // second check drains the same chain without relying on wall-clock sleeps.
        await f.credential.checkReminder(async () => { sends++; return true })
        expect(sends).toBe(1)
        stop()
        expect(stopped).toBe(true)
    })
    test('access-token login expires; JWT is capped; renewal rejects the old access token', async () => {
        const f = await fixture()
        const secret = randomBytes(32)
        const configuration = {
            get cliApiToken() { return f.cliToken },
            get workbenchWebToken() { return f.getWebToken() },
            workbenchCredential: f.credential,
            telegramEnabled: false
        } as ReturnType<typeof getConfiguration>
        const app = createAuthRoutes(secret, {} as Store, {
            getConfiguration: () => configuration, getOwnerId: async () => 1
        })
        const login = (accessToken: string) => app.request('/auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken })
        })
        f.setNow(Date.now())
        expect((await login(f.cliToken)).status).toBe(401)
        const normal = await login(f.getToken())
        const normalClaims = decodeJwt((await normal.json() as { token: string }).token)
        expect((normalClaims.exp ?? Infinity) - (normalClaims.iat ?? 0)).toBeLessThanOrEqual(4 * 3600)
        f.setNow(f.credential.expiresAt - 60_000)
        const old = f.getToken()
        const response = await login(old)
        expect(response.status).toBe(200)
        const claims = decodeJwt((await response.json() as { token: string }).token)
        expect(claims.cg).toBe(f.credential.generation)
        expect((claims.exp ?? Infinity) * 1000).toBeLessThanOrEqual(f.credential.expiresAt)
        const result = await f.credential.renew(f.credential.generation)
        expect((await login(old)).status).toBe(401)
        expect((await login(result.accessToken)).status).toBe(200)
        f.setNow(f.credential.expiresAt)
        const expired = await login(result.accessToken)
        expect(expired.status).toBe(401)
        expect(await expired.json()).toEqual({ error: 'credential_expired' })
        expect(cliLongTermTokenAllowed(f.cliToken, f.cliToken, f.getWebToken())).toBe(true)
        expect(cliLongTermTokenAllowed(f.getWebToken(), f.cliToken, f.getWebToken())).toBe(false)
    })
    test('missing issuance is persisted once; restarting retains it and unrelated settings', async () => {
        const f = await fixture()
        const saved = await readSettingsOrThrow(f.settingsFile)
        expect(saved.workbenchCredentialIssuedAt).toBe(f.credential.generation)
        expect(saved.workbenchWebToken).toBe(f.getWebToken())
        expect(saved.cliApiToken).toBe(f.cliToken)
        expect(saved.workbenchWebToken).not.toBe(f.cliToken)
        const restarted = new WorkbenchCredential(f.credential.ttlMs, f.settingsFile, () => {}, () => f.credential.generation + 1000)
        await restarted.initialize()
        expect(restarted.generation).toBe(f.credential.generation)
        expect((await readSettingsOrThrow(f.settingsFile)).workbenchWebToken).toBe(saved.workbenchWebToken)
        expect((await readSettingsOrThrow(f.settingsFile)).publicUrl).toBe('http://localhost')
    })

    test('renewal persists a random replacement and invalidates the previous generation', async () => {
        const f = await fixture()
        const old = f.getToken()
        const generation = f.credential.generation
        let disconnected = false
        f.credential.onRotate(() => { disconnected = true })
        const result = await f.credential.renew(generation)
        expect(result.accessToken).not.toBe(old)
        expect(result.accessToken.length).toBe(43)
        expect(f.getToken()).toBe(result.accessToken)
        expect((await readSettingsOrThrow(f.settingsFile)).workbenchWebToken).toBe(result.accessToken)
        expect((await readSettingsOrThrow(f.settingsFile)).cliApiToken).toBe(f.cliToken)
        expect(f.credential.accepts(generation)).toBe(false)
        expect(disconnected).toBe(true)
        await expect(f.credential.renew(generation)).rejects.toThrow('credential_expired')
    })

    test('concurrent renewals only commit one replacement', async () => {
        const f = await fixture()
        const generation = f.credential.generation
        const results = await Promise.allSettled([f.credential.renew(generation), f.credential.renew(generation)])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    })

    test('valid HTTP renewal retains namespace; old JWT fails HTTP and socket after renewal', async () => {
        const f = await fixture()
        const secret = randomBytes(32)
        const jwt = await new SignJWT({ uid: 1, ns: 'field', cg: f.credential.generation })
            .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('4h').sign(secret)
        const app = new Hono<WebAppEnv>()
        app.use('/api/*', createAuthMiddleware(secret, () => f.credential))
        app.route('/api', createWorkbenchCredentialRoutes(f.credential))
        const headers = { authorization: `Bearer ${jwt}` }
        expect((await app.request('/api/workbench/credential', { headers })).status).toBe(200)
        await verifyTerminalJwt(jwt, secret, f.credential)
        const response = await app.request('/api/workbench/credential/renew', { method: 'POST', headers })
        expect(response.status).toBe(200)
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        const body = await response.json() as { accessToken: string }
        expect(body.accessToken.endsWith(':field')).toBe(true)
        expect((await app.request('/api/workbench/credential', { headers })).status).toBe(401)
        await expect(verifyTerminalJwt(jwt, secret, f.credential)).rejects.toThrow('credential_expired')
    })

    test('disabled policy accepts ordinary JWT without cg', async () => {
        const secret = randomBytes(32)
        const jwt = await new SignJWT({ uid: 1, ns: 'default' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('4h').sign(secret)
        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(secret))
        app.get('/', c => c.json({ ok: true }))
        expect((await app.request('/', { headers: { authorization: `Bearer ${jwt}` } })).status).toBe(200)
        await verifyTerminalJwt(jwt, secret, null)
    })

    test('expired JWT generation refuses HTTP renewal and socket authentication', async () => {
        const f = await fixture()
        const secret = randomBytes(32)
        const jwt = await new SignJWT({ uid: 1, ns: 'default', cg: f.credential.generation })
            .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('4h').sign(secret)
        f.setNow(f.credential.expiresAt)
        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(secret, () => f.credential))
        app.route('/api', createWorkbenchCredentialRoutes(f.credential))
        const response = await app.request('/api/workbench/credential/renew', { method: 'POST', headers: { authorization: `Bearer ${jwt}` } })
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'credential_expired' })
        await expect(verifyTerminalJwt(jwt, secret, f.credential)).rejects.toThrow('credential_expired')
    })

    test('one reminder per generation, including across restarts; none outside window', async () => {
        const f = await fixture()
        let sends = 0
        const send = async () => { sends++; return true }
        await f.credential.checkReminder(send)
        expect(sends).toBe(0)
        f.setNow(f.credential.expiresAt - 48 * 3_600_000)
        await Promise.all([f.credential.checkReminder(send), f.credential.checkReminder(send)])
        expect(sends).toBe(1)
        const restart = new WorkbenchCredential(f.credential.ttlMs, f.settingsFile, () => {}, () => f.credential.expiresAt - 1000)
        await restart.initialize()
        await restart.checkReminder(send)
        expect(sends).toBe(1)
        f.setNow(f.credential.expiresAt)
        await f.credential.checkReminder(send)
        expect(sends).toBe(1)
        expect(await readFile(f.settingsFile, 'utf8')).not.toContain('credential-expiring')
    })

    test('failed sends remain retryable; renewal clears the persisted reminder marker', async () => {
        const f = await fixture()
        f.setNow(f.credential.expiresAt - 1000)
        await expect(f.credential.checkReminder(async () => { throw new Error('test transport failure') })).rejects.toThrow('test transport failure')
        expect((await readSettingsOrThrow(f.settingsFile)).workbenchCredentialRemindedFor).toBeUndefined()
        await f.credential.checkReminder(async () => false)
        expect((await readSettingsOrThrow(f.settingsFile)).workbenchCredentialRemindedFor).toBeUndefined()
        await f.credential.checkReminder(async () => true)
        expect((await readSettingsOrThrow(f.settingsFile)).workbenchCredentialRemindedFor).toBe(f.credential.generation)
        await f.credential.renew(f.credential.generation)
        expect((await readSettingsOrThrow(f.settingsFile)).workbenchCredentialRemindedFor).toBeUndefined()
        let sentAfterExpiry = false
        f.setNow(f.credential.expiresAt)
        await f.credential.checkReminder(async () => { sentAfterExpiry = true; return true })
        expect(sentAfterExpiry).toBe(false)
    })

    test('offline revoke and hub startup cannot both own the lifecycle lease', async () => {
        const f = await fixture()
        const release = await acquireCredentialLease(f.directory)
        try {
            await expect(acquireCredentialLease(f.directory)).rejects.toThrow('Hub is running')
        } finally {
            await release()
        }
        const next = await acquireCredentialLease(f.directory)
        await next()
    })

    test('disabled web login still accepts the CLI token and ignores a separate web token', async () => {
        const secret = randomBytes(32)
        const configuration = {
            cliApiToken: 'test-only-cli-token',
            workbenchWebToken: 'test-only-web-token',
            workbenchCredential: null,
            telegramEnabled: false
        } as ReturnType<typeof getConfiguration>
        const app = createAuthRoutes(secret, {} as Store, {
            getConfiguration: () => configuration, getOwnerId: async () => 1
        })
        const login = (accessToken: string) => app.request('/auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken })
        })
        expect((await login('test-only-cli-token')).status).toBe(200)
        expect((await login('test-only-web-token')).status).toBe(401)
        const bind = createBindRoutes(secret, {} as Store, { getConfiguration: () => configuration })
        const bindWith = (accessToken: string) => bind.request('/bind', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: 'x', accessToken })
        })
        expect((await bindWith('test-only-cli-token')).status).toBe(503)
        expect((await bindWith('test-only-web-token')).status).toBe(401)
    })

    test('enabled bind accepts the web token and rejects the CLI token', async () => {
        const f = await fixture()
        const secret = randomBytes(32)
        const configuration = {
            get cliApiToken() { return f.cliToken },
            get workbenchWebToken() { return f.getWebToken() },
            workbenchCredential: f.credential,
            telegramEnabled: false
        } as ReturnType<typeof getConfiguration>
        const bind = createBindRoutes(secret, {} as Store, { getConfiguration: () => configuration })
        const bindWith = (accessToken: string) => bind.request('/bind', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: 'x', accessToken })
        })
        expect((await bindWith(f.getWebToken())).status).toBe(503)
        expect((await bindWith(f.cliToken)).status).toBe(401)
    })

    test('cli guard rejects the web token only while the switch is on', async () => {
        const downstream = { called: false }
        const build = (enabled: boolean) => {
            const app = new Hono()
            app.use('*', createCliCredentialGuard(() => ({
                enabled, webToken: 'test-only-web-token'
            })))
            app.post('/cli/sessions', c => {
                downstream.called = true
                const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
                if (token !== 'test-only-cli-token') return c.json({ error: 'Invalid token' }, 401)
                return c.json({ ok: true })
            })
            return app
        }
        const call = (app: Hono, token: string) => app.request('/cli/sessions', {
            method: 'POST', headers: { authorization: `Bearer ${token}` }
        })
        downstream.called = false
        expect((await call(build(true), 'test-only-web-token')).status).toBe(401)
        expect(downstream.called).toBe(false)
        downstream.called = false
        expect((await call(build(true), 'test-only-cli-token')).status).toBe(200)
        expect(downstream.called).toBe(true)
        downstream.called = false
        expect((await call(build(false), 'test-only-web-token')).status).toBe(401)
        expect(downstream.called).toBe(true)
        expect((await call(build(false), 'test-only-cli-token')).status).toBe(200)
    })

    test('renewal and expiry close event streams; a disabled credential does not', async () => {
        const f = await fixture()
        let events = 0
        let voice = 0
        bindCredentialDisconnect(f.credential, () => {
            disconnectCredentialClients([{ close() { voice++ } }], { disconnectAll() { events++ } })
        })
        await f.credential.renew(f.credential.generation)
        expect(events).toBe(1)
        expect(voice).toBe(1)
        const pending: Array<() => void> = []
        f.setNow(f.credential.expiresAt - 10)
        const stop = f.credential.watchExpiry((_delay, callback) => {
            pending.push(callback)
            return () => {}
        })
        f.setNow(f.credential.expiresAt)
        pending[0]!()
        expect(events).toBe(2)
        expect(voice).toBe(2)
        stop()
        let disabled = 0
        bindCredentialDisconnect(null, () => { disabled++ })
        expect(disabled).toBe(0)

        let closed = 0
        const manager = new SSEManager(0, {
            registerConnection() {},
            removeConnection() {}
        } as unknown as VisibilityTracker)
        manager.subscribe({
            id: 'stream-1', namespace: 'default', send() {}, sendHeartbeat() {},
            close: () => { closed++ }
        })
        manager.disconnectAll()
        expect(closed).toBe(1)
        manager.stop()
    })

    test('an equal stored web token is replaced without changing the CLI token or issuance time', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-credential-test-'))
        directories.push(directory)
        const settingsFile = join(directory, 'settings.json')
        await updateSettings(settingsFile, settings => ({
            settings: {
                ...settings,
                cliApiToken: 'test-only-same-value',
                workbenchWebToken: 'test-only-same-value',
                workbenchCredentialIssuedAt: 5
            },
            result: undefined
        }))
        let seen = ''
        const credential = new WorkbenchCredential(30 * 86_400_000, settingsFile, token => { seen = token }, () => 5)
        await credential.initialize()
        const saved = await readSettingsOrThrow(settingsFile)
        expect(saved.cliApiToken).toBe('test-only-same-value')
        expect(saved.workbenchWebToken).not.toBe('test-only-same-value')
        expect(saved.workbenchWebToken).toBe(seen)
        expect(saved.workbenchCredentialIssuedAt).toBe(5)
        expect(credential.generation).toBe(5)
    })
})
