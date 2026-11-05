import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAuth, type AuthSource } from './useAuth'

const { authenticate, bind } = vi.hoisted(() => ({ authenticate: vi.fn(), bind: vi.fn() }))
vi.mock('@/api/client', () => ({
    ApiClient: class { authenticate = authenticate; bind = bind },
    ApiError: class extends Error {},
}))
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('login connection errors', () => {
    it('keeps successful login working', async () => {
        const auth = { token: 'jwt', user: { id: 'test' } }
        authenticate.mockResolvedValue(auth)
        const source: AuthSource = { type: 'accessToken', token: 'test' }
        const { result } = renderHook(() => useAuth(source, 'http://localhost'))
        await waitFor(() => expect(result.current.token).toBe('jwt'))
        expect(result.current.error).toBeNull()
        expect(authenticate).toHaveBeenCalledWith({ accessToken: 'test' })
    })
    it.each([new TypeError('Load failed'), new Error('Invalid access token')])(
        'formats binding failure and still rejects with the original error: %s', async error => {
            authenticate.mockResolvedValue({ token: 'jwt', user: { id: 'test' } })
            bind.mockRejectedValue(error)
            const source: AuthSource = { type: 'telegram', initData: 'test' }
            const { result } = renderHook(() => useAuth(source, 'http://localhost'))
            await waitFor(() => expect(result.current.token).toBe('jwt'))
            await act(async () => {
                await expect(result.current.bind('access')).rejects.toBe(error)
            })
            expect(result.current.error).toBe(error instanceof TypeError
                ? '连不上电脑，请打开手机上的 Tailscale 再试' : error.message)
            expect(result.current.isLoading).toBe(false)
        })
    it.each(['Load failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource.'])(
        'translates fetch TypeError: %s', async message => {
            authenticate.mockRejectedValue(new TypeError(message))
            const source: AuthSource = { type: 'accessToken', token: 'test' }
            const { result } = renderHook(() => useAuth(source, 'http://localhost'))
            await waitFor(() => expect(result.current.error).toBe('连不上电脑，请打开手机上的 Tailscale 再试'))
            expect(result.current.token).toBeNull()
            expect(result.current.isLoading).toBe(false)
        })
    it.each([new Error('Invalid access token'), new Error('Load failed'), new TypeError('Invalid URL')])(
        'preserves other error messages: %s', async error => {
            authenticate.mockRejectedValue(error)
            const source: AuthSource = { type: 'accessToken', token: 'test' }
            const { result } = renderHook(() => useAuth(source, 'http://localhost'))
            await waitFor(() => expect(result.current.error).toBe(error.message))
        })
    it('preserves unknown-error fallback', async () => {
        authenticate.mockRejectedValue('unknown')
        const source: AuthSource = { type: 'accessToken', token: 'test' }
        const { result } = renderHook(() => useAuth(source, 'http://localhost'))
        await waitFor(() => expect(result.current.error).toBe('Auth failed'))
    })
})
