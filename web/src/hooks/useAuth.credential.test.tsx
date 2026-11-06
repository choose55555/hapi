import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { ApiError } from '@/api/client'
import { useAuth, type AuthSource } from './useAuth'

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }))
vi.mock('@/api/client', () => ({
    ApiClient: class { authenticate = authenticate },
    ApiError: class extends Error {
        constructor(message: string, public status: number, public code?: string) { super(message) }
    }
}))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('explains an expired phone credential on the login page', async () => {
    authenticate.mockRejectedValue(new ApiError('Unauthorized', 401, 'credential_expired'))
    const source: AuthSource = { type: 'accessToken', token: 'test-only-old' }
    const { result } = renderHook(() => useAuth(source, 'http://localhost'))
    await waitFor(() => expect(result.current.error).toBe('手机登录凭据已过期，请回到电脑上开一个可遥控窗口，扫屏幕上的二维码重新登录'))
})
