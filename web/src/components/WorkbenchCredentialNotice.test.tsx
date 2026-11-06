import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { useAuthSource } from '@/hooks/useAuthSource'
import { WorkbenchCredentialNotice, formatCredentialDate } from './WorkbenchCredentialNotice'

vi.mock('@/hooks/useTelegram', () => ({ getTelegramWebApp: () => null, isTelegramEnvironment: () => false }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('credential expiry notice', () => {
    const now = Date.UTC(2026, 10, 6, 6, 0)
    const nearExpiry = now + 48 * 3_600_000
    function api(expiresAt: number) {
        return {
            getWorkbenchCredential: vi.fn().mockResolvedValue({ expiresAt }),
            renewWorkbenchCredential: vi.fn().mockResolvedValue({ accessToken: 'test-only-new', expiresAt: now + 30 * 86_400_000 })
        }
    }

    it('formats the expiry in Beijing time regardless of browser timezone', () => {
        expect(formatCredentialDate(now)).toBe('11-06 14:00')
        expect(formatCredentialDate(now, true)).toBe('11-06')
    })

    it('shows the settings button outside the reminder window', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(now)
        const client = api(now + 30 * 86_400_000)
        render(<WorkbenchCredentialNotice api={client as unknown as ApiClient} pathname="/settings" onRenew={() => {}} />)
        await screen.findByRole('button', { name: '换新凭据' })
        expect(screen.getByText(/手机登录凭据 .* 到期/)).toBeTruthy()
    })

    it('hides the home notice outside 48h, then shows it at the boundary', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(now)
        const client = api(nearExpiry + 1)
        const view = render(<WorkbenchCredentialNotice api={client as unknown as ApiClient} pathname="/" onRenew={() => {}} />)
        await waitFor(() => expect(client.getWorkbenchCredential).toHaveBeenCalled())
        expect(screen.queryByRole('button')).toBeNull()
        const near = api(nearExpiry)
        view.rerender(<WorkbenchCredentialNotice api={near as unknown as ApiClient} pathname="/" onRenew={() => {}} />)
        await screen.findByRole('button', { name: '换新凭据' })
    })

    it('uses useAuthSource storage and changes the auth source after renewal', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(now)
        const client = api(nearExpiry)
        function Harness() {
            const { setAccessToken, authSource } = useAuthSource('http://localhost')
            return <>
                <WorkbenchCredentialNotice api={client as unknown as ApiClient} pathname="/settings" onRenew={setAccessToken} />
                <span>{authSource?.type === 'accessToken' ? authSource.token : ''}</span>
            </>
        }
        render(<Harness />)
        fireEvent.click(await screen.findByRole('button', { name: '换新凭据' }))
        await waitFor(() => expect(localStorage.getItem('hapi_access_token::http://localhost')).toBe('test-only-new'))
        expect(screen.getByText('test-only-new')).toBeTruthy()
        expect(screen.getByRole('status').textContent).toContain('已换新，下次到期')
        expect(client.renewWorkbenchCredential).toHaveBeenCalledTimes(1)
    })

    it('does not replace local credentials on failure', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(now)
        const client = api(nearExpiry)
        client.renewWorkbenchCredential.mockRejectedValue(new Error('offline'))
        const renew = vi.fn()
        render(<WorkbenchCredentialNotice api={client as unknown as ApiClient} pathname="/settings" onRenew={renew} />)
        fireEvent.click(await screen.findByRole('button', { name: '换新凭据' }))
        await screen.findByText('换新未完成，请检查连接后重试')
        expect(renew).not.toHaveBeenCalled()
    })
})
