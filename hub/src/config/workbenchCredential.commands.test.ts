import { expect, test, spyOn } from 'bun:test'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { revokeWorkbenchCredential } from './workbenchCredentialLease'
import { printWorkbenchLoginQr } from './workbenchLoginQr'

test('offline command rotates token, issuance and JWT secret and prints no credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-offline-revoke-'))
    const prior = { home: process.env.HAPI_HOME, ttl: process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS, token: process.env.CLI_API_TOKEN, port: process.env.HAPI_LISTEN_PORT, host: process.env.HAPI_LISTEN_HOST }
    const oldToken = 'test-only-old-credential'
    const oldSecret = Buffer.alloc(32, 7).toString('base64')
    // Port 0 lets the operating system choose a free local probe port.
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ cliApiToken: oldToken, workbenchCredentialIssuedAt: 1000, listenPort: 0 }))
    await writeFile(join(directory, 'jwt-secret.json'), JSON.stringify({ secretBase64: oldSecret }))
    process.env.HAPI_HOME = directory
    process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS = '30'
    delete process.env.CLI_API_TOKEN
    delete process.env.HAPI_LISTEN_PORT
    process.env.HAPI_LISTEN_HOST = '127.0.0.1'
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
        await revokeWorkbenchCredential()
        const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
        const secret = JSON.parse(await readFile(join(directory, 'jwt-secret.json'), 'utf8'))
        expect(settings.cliApiToken).toBe(oldToken)
        expect(settings.workbenchWebToken).not.toBe(oldToken)
        expect(typeof settings.workbenchWebToken).toBe('string')
        expect(settings.workbenchWebToken.length).toBeGreaterThan(0)
        expect(settings.workbenchCredentialIssuedAt).toBeGreaterThan(1000)
        expect(secret.secretBase64).not.toBe(oldSecret)
        expect(log.mock.calls).toHaveLength(0)
        const printed = JSON.stringify(log.mock.calls)
        expect(printed).not.toContain(oldToken)
        expect(printed).not.toContain(settings.workbenchWebToken)
        expect(printed).not.toContain(secret.secretBase64)
    } finally {
        log.mockRestore()
        for (const [key, value] of Object.entries({ HAPI_HOME: prior.home, HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS: prior.ttl, CLI_API_TOKEN: prior.token, HAPI_LISTEN_PORT: prior.port, HAPI_LISTEN_HOST: prior.host })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(directory, { recursive: true, force: true })
    }
})

test('running legacy hub port refuses revocation without changing either credential file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-revoke-running-'))
    const prior = { home: process.env.HAPI_HOME, ttl: process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS, token: process.env.CLI_API_TOKEN, port: process.env.HAPI_LISTEN_PORT, host: process.env.HAPI_LISTEN_HOST }
    const server = createServer()
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    const originalSettings = JSON.stringify({ cliApiToken: 'test-only-unchanged', workbenchCredentialIssuedAt: 1000, listenPort: address.port })
    const originalSecret = JSON.stringify({ secretBase64: Buffer.alloc(32, 1).toString('base64') })
    await writeFile(join(directory, 'settings.json'), originalSettings)
    await writeFile(join(directory, 'jwt-secret.json'), originalSecret)
    process.env.HAPI_HOME = directory
    process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS = '30'
    delete process.env.CLI_API_TOKEN
    delete process.env.HAPI_LISTEN_PORT
    process.env.HAPI_LISTEN_HOST = '127.0.0.1'
    try {
        await expect(revokeWorkbenchCredential()).rejects.toThrow('Hub port is in use')
        expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(originalSettings)
        expect(await readFile(join(directory, 'jwt-secret.json'), 'utf8')).toBe(originalSecret)
    } finally {
        await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
        for (const [key, value] of Object.entries({ HAPI_HOME: prior.home, HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS: prior.ttl, CLI_API_TOKEN: prior.token, HAPI_LISTEN_PORT: prior.port, HAPI_LISTEN_HOST: prior.host })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(directory, { recursive: true, force: true })
    }
})

test('revoke is refused when the ttl switch is off and neither credential file changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-revoke-off-'))
    const prior = { home: process.env.HAPI_HOME, ttl: process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS, token: process.env.CLI_API_TOKEN }
    const originalSettings = JSON.stringify({ cliApiToken: 'test-only-cli-token', workbenchWebToken: 'test-only-web-token' })
    const originalSecret = JSON.stringify({ secretBase64: Buffer.alloc(32, 5).toString('base64') })
    await writeFile(join(directory, 'settings.json'), originalSettings)
    await writeFile(join(directory, 'jwt-secret.json'), originalSecret)
    process.env.HAPI_HOME = directory
    delete process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS
    delete process.env.CLI_API_TOKEN
    try {
        await expect(revokeWorkbenchCredential()).rejects.toThrow('HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS must be enabled')
        expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(originalSettings)
        expect(await readFile(join(directory, 'jwt-secret.json'), 'utf8')).toBe(originalSecret)
    } finally {
        for (const [key, value] of Object.entries({ HAPI_HOME: prior.home, HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS: prior.ttl, CLI_API_TOKEN: prior.token })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(directory, { recursive: true, force: true })
    }
})

function formatExpiry(expiresAt: number): string {
    // Independent of the implementation: Beijing time is UTC+8 with no DST.
    const d = new Date(expiresAt + 8 * 3_600_000)
    const two = (n: number) => String(n).padStart(2, '0')
    return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
}

async function withLoginQr(
    options: { settings: Record<string, unknown>; ttl?: string; publicUrl?: string },
    run: (captured: { output: () => string; logs: () => string[] }) => Promise<void>
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-login-qr-'))
    const prior = {
        HAPI_HOME: process.env.HAPI_HOME,
        HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS: process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS,
        CLI_API_TOKEN: process.env.CLI_API_TOKEN,
        HAPI_LISTEN_PORT: process.env.HAPI_LISTEN_PORT,
        HAPI_LISTEN_HOST: process.env.HAPI_LISTEN_HOST,
        HAPI_PUBLIC_URL: process.env.HAPI_PUBLIC_URL
    }
    const original = JSON.stringify(options.settings)
    await writeFile(join(directory, 'settings.json'), original)
    process.env.HAPI_HOME = directory
    delete process.env.CLI_API_TOKEN
    delete process.env.HAPI_LISTEN_PORT
    process.env.HAPI_LISTEN_HOST = '127.0.0.1'
    if (options.ttl === undefined) delete process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS
    else process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS = options.ttl
    if (options.publicUrl === undefined) delete process.env.HAPI_PUBLIC_URL
    else process.env.HAPI_PUBLIC_URL = options.publicUrl
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
        await run({
            output: () => JSON.stringify([...log.mock.calls, ...error.mock.calls]),
            logs: () => log.mock.calls.map(call => String(call[0] ?? ''))
        })
        expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(original)
        expect(await readdir(directory)).toEqual(['settings.json'])
    } finally {
        log.mockRestore()
        error.mockRestore()
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(directory, { recursive: true, force: true })
    }
}

test('login-qr prints the CLI token when the credential ttl switch is off', async () => {
    const token = 'test-only-login-token'
    await withLoginQr({
        settings: { cliApiToken: token, workbenchCredentialIssuedAt: Date.now() },
        publicUrl: 'http://127.0.0.1:9'
    }, async ({ logs, output }) => {
        await printWorkbenchLoginQr()
        expect(logs()).toContain(`http://127.0.0.1:9/?token=${token}`)
        expect(logs().some(line => line.startsWith('手机登录凭据'))).toBe(false)
        expect(output()).not.toContain('HAPI Hub starting')
    })
})

test('expired login-qr rejects and prints no token', async () => {
    const token = 'test-only-expired-token'
    await withLoginQr({
        settings: { cliApiToken: token, workbenchCredentialIssuedAt: 1 },
        ttl: '30',
        publicUrl: 'http://127.0.0.1:9'
    }, async ({ output }) => {
        await expect(printWorkbenchLoginQr()).rejects.toThrow('凭据已过期，请先运行 hapi hub revoke-credential 换新')
        expect(output()).not.toContain(token)
    })
})

test('login-qr prints the expiry, direct url and terminal qr for the web token only', async () => {
    const cliToken = 'test-only-cli-token'
    const webToken = 'test-only-web-token'
    const issuedAt = Date.now()
    const formatted = formatExpiry(issuedAt + 30 * 86_400_000)
    await withLoginQr({
        settings: { cliApiToken: cliToken, workbenchWebToken: webToken, workbenchCredentialIssuedAt: issuedAt },
        ttl: '30',
        publicUrl: 'http://127.0.0.1:9'
    }, async ({ logs }) => {
        await printWorkbenchLoginQr()
        const sentence = logs().find(line => line.startsWith('手机登录凭据'))
        expect(sentence).toBe(`手机登录凭据 ${formatted} 到期（北京时间）`)
        expect(sentence).toMatch(/^手机登录凭据 \d{2}-\d{2} \d{2}:\d{2} 到期（北京时间）$/)
        expect(logs()).toContain(`http://127.0.0.1:9/?token=${webToken}`)
        expect(logs().join('\n')).not.toContain(cliToken)
        expect(logs().some(line => line.includes('\n'))).toBe(true)
    })
})

test('login-qr errors when HAPI_PUBLIC_URL is missing', async () => {
    const token = 'test-only-login-token'
    await withLoginQr({
        settings: { cliApiToken: token, workbenchCredentialIssuedAt: Date.now() },
        ttl: '30'
    }, async ({ output }) => {
        await expect(printWorkbenchLoginQr()).rejects.toThrow('HAPI_PUBLIC_URL is required')
        expect(output()).not.toContain(token)
    })
})

test('login-qr still prints while the hub port is in use', async () => {
    const server = createServer()
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    const cliToken = 'test-only-cli-token'
    const webToken = 'test-only-web-token'
    try {
        await withLoginQr({
            settings: { cliApiToken: cliToken, workbenchWebToken: webToken, workbenchCredentialIssuedAt: Date.now(), listenPort: address.port },
            ttl: '30',
            publicUrl: 'http://127.0.0.1:9'
        }, async ({ logs }) => {
            await printWorkbenchLoginQr()
            expect(logs()).toContain(`http://127.0.0.1:9/?token=${webToken}`)
            expect(logs().join('\n')).not.toContain(cliToken)
        })
    } finally {
        await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    }
})

test('failed secret rotation restores settings and leaves the CLI token and JWT secret unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-revoke-restore-'))
    const prior = { home: process.env.HAPI_HOME, ttl: process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS, token: process.env.CLI_API_TOKEN, port: process.env.HAPI_LISTEN_PORT, host: process.env.HAPI_LISTEN_HOST }
    const originalSettings = JSON.stringify({ cliApiToken: 'test-only-cli-token', workbenchCredentialIssuedAt: 1000, listenPort: 0 })
    const originalSecret = JSON.stringify({ secretBase64: Buffer.alloc(32, 3).toString('base64') })
    await writeFile(join(directory, 'settings.json'), originalSettings)
    await writeFile(join(directory, 'jwt-secret.json'), originalSecret)
    process.env.HAPI_HOME = directory
    process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS = '30'
    delete process.env.CLI_API_TOKEN
    delete process.env.HAPI_LISTEN_PORT
    process.env.HAPI_LISTEN_HOST = '127.0.0.1'
    let during = ''
    try {
        await expect(revokeWorkbenchCredential({
            rotateJwtSecret: async () => {
                during = await readFile(join(directory, 'settings.json'), 'utf8')
                throw new Error('jwt rotation failed')
            }
        })).rejects.toThrow('jwt rotation failed')
        const midway = JSON.parse(during)
        expect(midway.cliApiToken).toBe('test-only-cli-token')
        expect(typeof midway.workbenchWebToken).toBe('string')
        expect(midway.workbenchWebToken).not.toBe('test-only-cli-token')
        expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(originalSettings)
        expect(await readFile(join(directory, 'jwt-secret.json'), 'utf8')).toBe(originalSecret)
        expect(during).not.toBe(originalSettings)
    } finally {
        for (const [key, value] of Object.entries({ HAPI_HOME: prior.home, HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS: prior.ttl, CLI_API_TOKEN: prior.token, HAPI_LISTEN_PORT: prior.port, HAPI_LISTEN_HOST: prior.host })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(directory, { recursive: true, force: true })
    }
})

test('unreadable settings refuse revocation and leave the JWT secret unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-revoke-settings-'))
    const prior = { home: process.env.HAPI_HOME, ttl: process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS, token: process.env.CLI_API_TOKEN, port: process.env.HAPI_LISTEN_PORT, host: process.env.HAPI_LISTEN_HOST }
    const originalSettings = '{'
    const originalSecret = JSON.stringify({ secretBase64: Buffer.alloc(32, 4).toString('base64') })
    await writeFile(join(directory, 'settings.json'), originalSettings)
    await writeFile(join(directory, 'jwt-secret.json'), originalSecret)
    process.env.HAPI_HOME = directory
    process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS = '30'
    delete process.env.CLI_API_TOKEN
    delete process.env.HAPI_LISTEN_PORT
    process.env.HAPI_LISTEN_HOST = '127.0.0.1'
    try {
        await expect(revokeWorkbenchCredential()).rejects.toThrow('Cannot read')
        expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(originalSettings)
        expect(await readFile(join(directory, 'jwt-secret.json'), 'utf8')).toBe(originalSecret)
    } finally {
        for (const [key, value] of Object.entries({ HAPI_HOME: prior.home, HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS: prior.ttl, CLI_API_TOKEN: prior.token, HAPI_LISTEN_PORT: prior.port, HAPI_LISTEN_HOST: prior.host })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(directory, { recursive: true, force: true })
    }
})

test('login-qr with the switch off prints the CLI token and not the web token', async () => {
    const cliToken = 'test-only-cli-token'
    const webToken = 'test-only-web-token'
    await withLoginQr({
        settings: { cliApiToken: cliToken, workbenchWebToken: webToken, workbenchCredentialIssuedAt: Date.now() },
        publicUrl: 'http://127.0.0.1:9'
    }, async ({ logs, output }) => {
        await printWorkbenchLoginQr()
        expect(logs()).toContain(`http://127.0.0.1:9/?token=${cliToken}`)
        expect(output()).not.toContain(webToken)
        expect(logs().some(line => line.startsWith('手机登录凭据'))).toBe(false)
    })
})

test('login-qr prints no token when the issuance time is missing', async () => {
    const token = 'test-only-login-token'
    await withLoginQr({
        settings: { cliApiToken: token },
        ttl: '30',
        publicUrl: 'http://127.0.0.1:9'
    }, async ({ output }) => {
        await expect(printWorkbenchLoginQr()).rejects.toThrow('Invalid workbench credential issuance time')
        expect(output()).not.toContain(token)
    })
})
