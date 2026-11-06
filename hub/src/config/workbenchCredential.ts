import { randomBytes } from 'node:crypto'
import { constantTimeEquals } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'
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

export function createDistinctWebToken(cliApiToken: string | undefined): string {
    for (let attempt = 0; attempt < 4; attempt++) {
        const token = randomBytes(32).toString('base64url')
        if (token !== cliApiToken) return token
    }
    throw new Error('Could not generate a distinct web login token')
}

export function webLoginTokenMatches(presented: string, cliApiToken: string, webToken: string | null, ttlEnabled: boolean): boolean {
    const parsed = parseAccessToken(presented)
    if (!parsed) return false
    const expected = ttlEnabled ? webToken : cliApiToken
    return typeof expected === 'string' && expected.length > 0 && constantTimeEquals(parsed.baseToken, expected)
}

/** /cli keeps the upstream comparison. When the TTL switch is on, the phone web token is never accepted. */
export function cliLongTermTokenAllowed(token: string | null, cliApiToken: string, webToken: string | null): boolean {
    const parsed = token ? parseAccessToken(token) : null
    if (!parsed || !constantTimeEquals(parsed.baseToken, cliApiToken)) return false
    if (webToken !== null && constantTimeEquals(parsed.baseToken, webToken)) return false
    return true
}

export function countDelivered(result: unknown): number {
    if (typeof result === 'number' && Number.isFinite(result) && result > 0) return Math.floor(result)
    if (result && typeof result === 'object' && 'sent' in result) {
        const sent = (result as { sent: unknown }).sent
        if (typeof sent === 'number' && Number.isFinite(sent) && sent > 0) return Math.floor(sent)
    }
    return 0
}

export async function deliverReminderToNamespaces(
    namespaces: readonly string[],
    deliver: (namespace: string) => Promise<number>
): Promise<boolean> {
    let delivered = 0
    for (const namespace of namespaces) delivered += await deliver(namespace)
    return delivered > 0
}

export function credentialReminderDue(ttlMs: number | null, issuedAt: number, remindedFor: number | undefined, now: number): boolean {
    if (ttlMs === null || remindedFor === issuedAt) return false
    const remaining = issuedAt + ttlMs - now
    return remaining > 0 && remaining <= 48 * 3_600_000
}

export async function startCredentialReminderChecks(
    credential: WorkbenchCredential | null,
    send: (expiresAt: number) => Promise<boolean>,
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
            let webToken = settings.workbenchWebToken
            const replaceToken = typeof webToken !== 'string' || webToken.length === 0 || webToken === settings.cliApiToken
            if (replaceToken) webToken = createDistinctWebToken(settings.cliApiToken)
            if (typeof webToken !== 'string' || webToken.length === 0) {
                throw new Error('Could not generate a distinct web login token')
            }
            const storedWebToken = webToken
            return {
                settings: { ...settings, workbenchCredentialIssuedAt: issuedAt, workbenchWebToken: storedWebToken },
                result: undefined,
                write: issued === undefined || replaceToken,
                afterCommit: () => {
                    this.issuedAt = issuedAt
                    this.remindedFor = settings.workbenchCredentialRemindedFor
                    this.setToken(storedWebToken)
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
            let accessToken = ''
            const issuedAt = Math.max(this.now(), this.issuedAt + 1)
            await updateSettings(this.settingsFile, (settings) => {
                this.assertGeneration(settings)
                accessToken = createDistinctWebToken(settings.cliApiToken)
                return {
                    settings: {
                        ...settings,
                        workbenchWebToken: accessToken,
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
            const delivered = await send(this.expiresAt)
            if (delivered !== true) return
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
