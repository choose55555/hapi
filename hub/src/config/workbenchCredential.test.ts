import { describe, expect, test } from 'bun:test'
import { credentialExpiry, credentialGenerationMatches, credentialReminderDue, parseCredentialTtl } from './workbenchCredential'

describe('workbench credential opt-in policy', () => {
    test('disabled and malformed values preserve upstream policy', () => {
        for (const value of [undefined, '', '0', '-1', '1.5', '30days']) {
            expect(parseCredentialTtl(value)).toBeNull()
        }
        expect(parseCredentialTtl('30')).toBe(30 * 86_400_000)
        expect(credentialGenerationMatches(null, 100, undefined, 200)).toBe(true)
    })

    test('JWT expiry never extends beyond credential expiry', () => {
        expect(credentialExpiry(1000, 30, 1010)).toBe(1030)
        expect(credentialExpiry(1000, 30_000_000, 1010)).toBe(14_401_010)
    })

    test('HTTP and socket share generation and expiry validation', () => {
        expect(credentialGenerationMatches(100, 1000, 1000, 1099)).toBe(true)
        expect(credentialGenerationMatches(100, 1000, 999, 1099)).toBe(false)
        expect(credentialGenerationMatches(100, 1000, undefined, 1099)).toBe(false)
        expect(credentialGenerationMatches(100, 1000, 1000, 1100)).toBe(false)
    })

    test('reminder window includes 48h boundary, excludes expiry and persisted generation', () => {
        const ttl = 30 * 86_400_000
        const issued = 1000
        const windowStart = issued + ttl - 48 * 3_600_000
        expect(credentialReminderDue(ttl, issued, undefined, windowStart - 1)).toBe(false)
        expect(credentialReminderDue(ttl, issued, undefined, windowStart)).toBe(true)
        expect(credentialReminderDue(ttl, issued, issued, windowStart)).toBe(false)
        expect(credentialReminderDue(ttl, issued, undefined, issued + ttl)).toBe(false)
        expect(credentialReminderDue(null, issued, undefined, windowStart)).toBe(false)
    })
})
