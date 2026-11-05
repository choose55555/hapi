import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingSendIdentity, forgetSendIdentity } from './pendingSendIdentity'
afterEach(() => vi.unstubAllGlobals())
describe('pending identity across page remounts', () => {
    it('reuses the durable draft identity and isolates accounts', () => {
        const data = new Map<string, string>()
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => { data.set(key, value) },
            removeItem: (key: string) => { data.delete(key) },
        })
        let count = 0
        const allocate = () => ({ localId: 'id-' + ++count, createdAt: 123 })
        const first = pendingSendIdentity('account-A', 'same-intent', allocate)
        expect(pendingSendIdentity('account-A', 'same-intent', allocate)).toEqual(first)
        expect(pendingSendIdentity('account-B', 'same-intent', allocate).localId).not.toBe(first.localId)
        forgetSendIdentity(first.storageKey)
        expect(pendingSendIdentity('account-A', 'same-intent', allocate).localId).not.toBe(first.localId)
    })
    it('does not bind unscoped senders to another account storage', () => {
        const write = vi.fn()
        vi.stubGlobal('sessionStorage', { setItem: write })
        expect(pendingSendIdentity(null, 'intent', () => ({ localId: 'fresh', createdAt: 1 })).storageKey).toBeNull()
        expect(write).not.toHaveBeenCalled()
    })
})
