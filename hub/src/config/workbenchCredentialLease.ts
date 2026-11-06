import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink, mkdir, rename } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSettingsFile, withSettingsLock, updateSettings, readSettingsOrThrow, forgetSettingsReadCache } from './settings'
import { createDistinctWebToken, parseCredentialTtl } from './workbenchCredential'

export function workbenchDataDir(): string {
    return process.env.HAPI_HOME ? process.env.HAPI_HOME.replace(/^~/, homedir()) : join(homedir(), '.hapi')
}

// Shared by opt-in hub startup and offline revocation. A stale lease is only
// reclaimed under the same settings lock after its PID is proven absent.
export async function acquireCredentialLease(dataDir: string): Promise<() => Promise<void>> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const path = join(dataDir, 'workbench-credential-hub.json')
    const nonce = randomUUID()
    await withSettingsLock(getSettingsFile(dataDir), async () => {
        let existing: { pid: number } | null = null
        try {
            existing = JSON.parse(await readFile(path, 'utf8'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot verify hub state')
        }
        if (existing) {
            if (!Number.isInteger(existing.pid) || existing.pid <= 0) throw new Error('Cannot verify hub state')
            try {
                process.kill(existing.pid, 0)
                throw new Error('Hub is running; stop it before revoking the credential')
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            }
        }
        await writeFile(path, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 })
    })
    return async () => {
        await withSettingsLock(getSettingsFile(dataDir), async () => {
            const existing = JSON.parse(await readFile(path, 'utf8'))
            if (existing.nonce !== nonce) throw new Error('Hub state changed; refusing cleanup')
            await unlink(path)
        })
    }
}

async function rotateJwtSecret(dataDir: string): Promise<void> {
    const temporarySecret = join(dataDir, `.jwt-secret.${randomUUID()}.tmp`)
    try {
        await writeFile(temporarySecret, JSON.stringify({
            secretBase64: randomBytes(32).toString('base64')
        }), { mode: 0o600, flag: 'wx' })
        await rename(temporarySecret, join(dataDir, 'jwt-secret.json'))
    } catch (error) {
        await unlink(temporarySecret).catch(() => {})
        throw error
    }
}

export async function revokeWorkbenchCredential(deps: {
    rotateJwtSecret?: (dataDir: string) => Promise<void>
} = {}): Promise<void> {
    if (parseCredentialTtl(process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS) === null) {
        throw new Error('HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS must be enabled')
    }
    if (process.env.CLI_API_TOKEN !== undefined) throw new Error('Remove CLI_API_TOKEN before revoking')
    const dataDir = workbenchDataDir()
    const release = await acquireCredentialLease(dataDir)
    try {
        // Also detect a pre-v6 / opt-out hub which has no lifecycle lease.
        const settingsFile = getSettingsFile(dataDir)
        const settings = await readSettingsOrThrow(settingsFile)
        const envPort = process.env.HAPI_LISTEN_PORT?.trim()
        const port = Number(envPort ? envPort : (settings.listenPort ?? 3006))
        const host = process.env.HAPI_LISTEN_HOST || settings.listenHost || '127.0.0.1'
        await new Promise<void>((resolve, reject) => {
            const probe = createServer()
            probe.once('error', () => reject(new Error('Hub port is in use or cannot be checked; stop the hub before revoking')))
            probe.listen(port, host, () => { probe.close(error => error ? reject(error) : resolve()) })
        })
        // Write the new web token first. Rotate the JWT secret only after that
        // write succeeds. If the secret step fails, put the original settings back.
        let originalSettings: Buffer | null = null
        try {
            originalSettings = await readFile(settingsFile)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        let settingsWritten = false
        try {
            await updateSettings(settingsFile, current => ({
                settings: {
                    ...current,
                    workbenchWebToken: createDistinctWebToken(current.cliApiToken),
                    workbenchCredentialIssuedAt: Math.max(Date.now(), (current.workbenchCredentialIssuedAt ?? 0) + 1),
                    workbenchCredentialRemindedFor: undefined
                },
                result: undefined
            }))
            settingsWritten = true
            await (deps.rotateJwtSecret ?? rotateJwtSecret)(dataDir)
        } catch (error) {
            if (!settingsWritten) throw error
            try {
                if (originalSettings === null) {
                    await unlink(settingsFile).catch((unlinkError: NodeJS.ErrnoException) => {
                        if (unlinkError?.code !== 'ENOENT') throw unlinkError
                    })
                }
                else await writeFile(settingsFile, originalSettings)
                forgetSettingsReadCache()
            } catch (restoreError) {
                const reason = error instanceof Error ? error.message : 'secret rotation failed'
                const restoreReason = restoreError instanceof Error ? restoreError.message : 'restore failed'
                throw new Error(`Credential revoke failed (${reason}) and restoring settings failed (${restoreReason})`)
            }
            throw error
        }
    } finally {
        await release()
    }
}
