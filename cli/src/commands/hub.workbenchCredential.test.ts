import { expect, test, spyOn } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { hubCommand } from './hub'
import type { CommandContext } from './types'

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
        await hubCommand.run({ commandArgs: ['revoke-credential'] } as CommandContext)
        const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
        const secret = JSON.parse(await readFile(join(directory, 'jwt-secret.json'), 'utf8'))
        expect(settings.cliApiToken).not.toBe(oldToken)
        expect(settings.workbenchCredentialIssuedAt).toBeGreaterThan(1000)
        expect(secret.secretBase64).not.toBe(oldSecret)
        expect(log.mock.calls).toHaveLength(1)
        const printed = JSON.stringify(log.mock.calls)
        expect(printed).not.toContain(oldToken)
        expect(printed).not.toContain(settings.cliApiToken)
        expect(printed).not.toContain(secret.secretBase64)
        expect(printed).toContain('revoked')
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
        const { revokeWorkbenchCredential } = await import('hapi-hub/startHub')
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
