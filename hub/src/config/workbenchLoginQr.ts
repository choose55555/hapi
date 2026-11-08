import QRCode from 'qrcode'
import { getSettingsFile, readSettingsOrThrow } from './settings'
import { parseCredentialTtl } from './workbenchCredential'
import { workbenchDataDir } from './workbenchCredentialLease'

export function formatExpiry(expiresAt: number): string {
    // Beijing time is UTC+8 with no DST. Built by hand: locale layouts differ between
    // runtimes (Bun printed "06/12 19:19" for sv-SE), so never rely on one.
    const d = new Date(expiresAt + 8 * 3_600_000)
    const two = (n: number) => String(n).padStart(2, '0')
    return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
}

function directAccessUrl(publicUrl: string, token: string): string {
    let url: URL
    try {
        url = new URL(publicUrl)
    } catch {
        throw new Error('HAPI_PUBLIC_URL must be an absolute http(s) URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('HAPI_PUBLIC_URL must be an absolute http(s) URL')
    }
    url.searchParams.set('token', token)
    return url.toString()
}

async function printDirectAccessQr(directUrl: string): Promise<void> {
    console.log(directUrl)
    try {
        const qrString = await QRCode.toString(directUrl, {
            type: 'terminal',
            small: true,
            margin: 1,
            errorCorrectionLevel: 'L'
        })
        console.log('')
        console.log(qrString)
    } catch {
        // Same as startHub: a QR failure still leaves the address on screen.
    }
}

// Read-only on purpose: this must work while the hub is running, so it does not
// take the lifecycle lease or probe the listen port, and it writes no log file.
// When the 30-day switch is off, web login accepts cliApiToken, so the QR carries
// that token and still does not start the hub or require a remote window.
export async function printWorkbenchLoginQr(): Promise<void> {
    const ttlMs = parseCredentialTtl(process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS)
    if (ttlMs === null) {
        const settings = await readSettingsOrThrow(getSettingsFile(workbenchDataDir()))
        const publicUrl = process.env.HAPI_PUBLIC_URL?.trim()
        if (!publicUrl) throw new Error('HAPI_PUBLIC_URL is required')
        const token = settings.cliApiToken
        if (typeof token !== 'string' || token.length === 0) {
            throw new Error('settings.json has no CLI login token')
        }
        await printDirectAccessQr(directAccessUrl(publicUrl, token))
        return
    }

    const settings = await readSettingsOrThrow(getSettingsFile(workbenchDataDir()))
    const token = settings.workbenchWebToken
    const issuedAt = settings.workbenchCredentialIssuedAt
    if (issuedAt === undefined || !Number.isSafeInteger(issuedAt) || issuedAt <= 0 || !Number.isSafeInteger(issuedAt + ttlMs)) {
        throw new Error('Invalid workbench credential issuance time')
    }
    if (Date.now() >= issuedAt + ttlMs) {
        throw new Error('凭据已过期，请先运行 hapi hub revoke-credential 换新')
    }
    const publicUrl = process.env.HAPI_PUBLIC_URL?.trim()
    if (!publicUrl) throw new Error('HAPI_PUBLIC_URL is required')
    if (typeof token !== 'string' || token.length === 0) {
        throw new Error('settings.json has no web login token')
    }
    if (typeof settings.cliApiToken === 'string' && settings.cliApiToken.length > 0 && token === settings.cliApiToken) {
        throw new Error('Web login token must be distinct from the CLI token; run hapi hub revoke-credential')
    }
    console.log(`手机登录凭据 ${formatExpiry(issuedAt + ttlMs)} 到期（北京时间）`)
    await printDirectAccessQr(directAccessUrl(publicUrl, token))
}
