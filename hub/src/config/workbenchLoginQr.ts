import QRCode from 'qrcode'
import { getSettingsFile, readSettingsOrThrow } from './settings'
import { parseCredentialTtl } from './workbenchCredential'
import { workbenchDataDir } from './workbenchCredentialLease'

function formatExpiry(expiresAt: number): string {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(expiresAt)
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

// Read-only on purpose: this must work while the hub is running, so it does not
// take the lifecycle lease or probe the listen port, and it writes no log file.
export async function printWorkbenchLoginQr(): Promise<void> {
    const ttlMs = parseCredentialTtl(process.env.HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS)
    if (ttlMs === null) throw new Error('HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS must be enabled')
    const settings = await readSettingsOrThrow(getSettingsFile(workbenchDataDir()))
    const token = settings.cliApiToken
    const issuedAt = settings.workbenchCredentialIssuedAt
    if (typeof token !== 'string' || token.length === 0) {
        throw new Error('settings.json has no CLI API token')
    }
    if (issuedAt === undefined || !Number.isSafeInteger(issuedAt) || issuedAt <= 0 || !Number.isSafeInteger(issuedAt + ttlMs)) {
        throw new Error('Invalid workbench credential issuance time')
    }
    if (Date.now() >= issuedAt + ttlMs) {
        throw new Error('凭据已过期，请先运行 hapi hub revoke-credential 换新')
    }
    const publicUrl = process.env.HAPI_PUBLIC_URL?.trim()
    if (!publicUrl) throw new Error('HAPI_PUBLIC_URL is required')
    const directUrl = directAccessUrl(publicUrl, token)
    console.log(`手机登录凭据 ${formatExpiry(issuedAt + ttlMs)} 到期（北京时间）`)
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
