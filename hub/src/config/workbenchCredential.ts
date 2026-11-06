import { randomBytes } from 'node:crypto'
import { updateSettings, type Settings } from './settings'

export function parseCredentialTtl(raw: string | undefined): number | null {
    if (!raw || !/^[1-9]\d*$/.test(raw)) return null
    const days = Number(raw)
    const milliseconds = days * 86_400_000
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null
}

export function credentialExpiry(issuedAt: number, ttlMs: number, now: number): number {
    return Math.min(now + 4 * 3_600_000, issuedAt + ttlMs)
}

export function credentialGenerationMatches(ttlMs: number | null, issuedAt: number, cg: unknown, now: number): boolean {
    return ttlMs === null || (cg === issuedAt && now < issuedAt + ttlMs)
}

export function credentialReminderDue(ttlMs: number | null, issuedAt: number, remindedFor: number | undefined, now: number): boolean {
    if (ttlMs === null || remindedFor === issuedAt) return false
    const remaining = issuedAt + ttlMs - now
    return remaining > 0 && remaining <= 48 * 3_600_000
}

export async function startCredentialReminderChecks(
    credential: WorkbenchCredential | null,
    send: (expiresAt: number) => Promise<void>,
    timers: { every: (check: () => void, milliseconds: number) => () => void } = {
        every: (check, milliseconds) => {
            const timer = setInterval(check, milliseconds)
            return () => { clearInterval(timer) }
        }
    }
): Promise<() => void> {
    if (!credential) return () => {}
    const check = () => credential.checkReminder(send).catch(() => {
        console.error('[Hub] Credential reminder failed')
    })
    await check()
    return timers.every(() => { void check() }, 3_600_000)
}

export class WorkbenchCredential {
    private issuedAt = 0
    private remindedFor: number | undefined
    private readonly listeners = new Set<() => void>()
    private chain: Promise<unknown> = Promise.resolve()
    private rescheduleExpiry: (() => void) | undefined

    constructor(
        readonly ttlMs: number,
        private readonly settingsFile: string,
        private readonly setToken: (token: string) => void,
        private readonly now: () => number = Date.now
    ) {}

    private serialize<T>(work: () => Promise<T>): Promise<T> {
        const result = this.chain.catch(() => undefined).then(work)
        this.chain = result
        return result
    }

    async initialize(): Promise<void> {
        await updateSettings(this.settingsFile, (settings) => {
            const issued = settings.workbenchCredentialIssuedAt
            if (issued !== undefined && (!Number.isSafeInteger(issued) || issued <= 0 || !Number.isSafeInteger(issued + this.ttlMs))) {
                throw new Error('Invalid workbench credential issuance time')
            }
            const issuedAt = issued ?? this.now()
            return {
                settings: { ...settings, workbenchCredentialIssuedAt: issuedAt },
                result: undefined,
                write: issued === undefined,
                afterCommit: () => {
                    this.issuedAt = issuedAt
                    this.remindedFor = settings.workbenchCredentialRemindedFor
                }
            }
        })
    }

    get generation(): number { return this.issuedAt }
    get expiresAt(): number { return this.issuedAt + this.ttlMs }
    get expired(): boolean { return this.now() >= this.expiresAt }

    accepts(cg: unknown): boolean {
        return credentialGenerationMatches(this.ttlMs, this.issuedAt, cg, this.now())
    }

    jwtExpiresAt(): number {
        return Math.floor(credentialExpiry(this.issuedAt, this.ttlMs, this.now()) / 1000)
    }

    onRotate(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    private invalidateConnections(): void {
        for (const listener of this.listeners) {
            try { listener() } catch { console.error('[Hub] Credential connection cleanup failed') }
        }
    }

    watchExpiry(after: (milliseconds: number, callback: () => void) => () => void = (milliseconds, callback) => {
        const timer = setTimeout(callback, milliseconds)
        return () => { clearTimeout(timer) }
    }): () => void {
        let cancel = () => {}
        let stopped = false
        const schedule = () => {
            cancel()
            if (stopped) return
            const remaining = this.expiresAt - this.now()
            if (remaining <= 0) {
                this.invalidateConnections()
                return
            }
            // Node/Bun timers clamp values above signed 32-bit milliseconds.
            cancel = after(Math.min(remaining, 2_147_483_647), schedule)
        }
        this.rescheduleExpiry = schedule
        schedule()
        return () => {
            stopped = true
            cancel()
            if (this.rescheduleExpiry === schedule) this.rescheduleExpiry = undefined
        }
    }

    renew(expectedGeneration: unknown): Promise<{ accessToken: string; expiresAt: number }> {
        return this.serialize(async () => {
            if (!this.accepts(expectedGeneration)) throw new Error('credential_expired')
            const accessToken = randomBytes(32).toString('base64url')
            const issuedAt = Math.max(this.now(), this.issuedAt + 1)
            await updateSettings(this.settingsFile, (settings) => {
                this.assertGeneration(settings)
                return {
                    settings: {
                        ...settings,
                        cliApiToken: accessToken,
                        workbenchCredentialIssuedAt: issuedAt,
                        workbenchCredentialRemindedFor: undefined
                    },
                    result: undefined,
                    afterCommit: () => {
                        this.issuedAt = issuedAt
                        this.remindedFor = undefined
                        this.setToken(accessToken)
                    }
                }
            })
            this.rescheduleExpiry?.()
            this.invalidateConnections()
            return { accessToken, expiresAt: this.expiresAt }
        })
    }

    private assertGeneration(settings: Settings): void {
        if (settings.workbenchCredentialIssuedAt !== this.issuedAt) {
            throw new Error('Credential changed outside this hub; restart required')
        }
    }

    checkReminder(send: (expiresAt: number) => Promise<void>): Promise<void> {
        return this.serialize(async () => {
            if (!credentialReminderDue(this.ttlMs, this.issuedAt, this.remindedFor, this.now())) return
            await send(this.expiresAt)
            await updateSettings(this.settingsFile, (settings) => {
                this.assertGeneration(settings)
                return {
                    settings: { ...settings, workbenchCredentialRemindedFor: this.issuedAt },
                    result: undefined,
                    afterCommit: () => { this.remindedFor = this.issuedAt }
                }
            })
        })
    }
}
