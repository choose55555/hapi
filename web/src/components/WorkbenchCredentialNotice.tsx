import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'

export function formatCredentialDate(time: number, dayOnly = false): string {
    // Beijing time is UTC+8 with no DST; build MM-dd[ HH:mm] by hand so the layout
    // does not depend on the phone browser's locale data.
    const d = new Date(time + 8 * 3_600_000)
    const two = (n: number) => String(n).padStart(2, '0')
    const day = `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
    return dayOnly ? day : `${day} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
}

export function WorkbenchCredentialNotice(props: {
    api: ApiClient
    pathname: string
    onRenew: (accessToken: string, expiresAt: number) => void
}) {
    const [expiresAt, setExpiresAt] = useState<number | null>(null)
    const [now, setNow] = useState(Date.now)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const renewing = useRef(false)

    useEffect(() => {
        let cancelled = false
        const refresh = async () => {
            try {
                const result = await props.api.getWorkbenchCredential()
                if (!cancelled) {
                    setExpiresAt(result.expiresAt)
                    setNow(Date.now())
                }
            } catch {
                // Authentication failures are handled by useAuth.
            }
        }
        void refresh()
        const interval = setInterval(() => { void refresh() }, 60_000)
        return () => { cancelled = true; clearInterval(interval) }
    }, [props.api])

    const renew = async () => {
        if (renewing.current) return
        renewing.current = true
        setBusy(true)
        setMessage('')
        try {
            const result = await props.api.renewWorkbenchCredential()
            props.onRenew(result.accessToken, result.expiresAt)
            setExpiresAt(result.expiresAt)
            setMessage(`已换新，下次到期 ${formatCredentialDate(result.expiresAt, true)}`)
        } catch {
            setMessage('换新未完成，请检查连接后重试')
        } finally {
            renewing.current = false
            setBusy(false)
        }
    }

    const settings = props.pathname === '/settings' || props.pathname.startsWith('/settings/')
    const home = props.pathname === '/' || props.pathname === '/sessions'
    const nearExpiry = expiresAt !== null && expiresAt - now <= 48 * 3_600_000
    if (expiresAt === null || (!settings && !(home && nearExpiry) && !message)) return null

    return (
        <section className="px-3 py-2" aria-label="手机登录凭据">
            <p>{nearExpiry ? '手机登录凭据快到期。' : ''}手机登录凭据 {formatCredentialDate(expiresAt)} 到期（北京时间）</p>
            <button type="button" onClick={() => { void renew() }} disabled={busy || now >= expiresAt}>
                {busy ? '正在换新…' : '换新凭据'}
            </button>
            {message && <p role="status">{message}</p>}
        </section>
    )
}
