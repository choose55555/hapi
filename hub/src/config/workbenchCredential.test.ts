import { describe, expect, test } from 'bun:test'
import { cliLongTermTokenAllowed, countDelivered, createDistinctWebToken, credentialExpiry, credentialGenerationMatches, credentialReminderDue, deliverReminderToNamespaces, parseCredentialTtl, webLoginTokenMatches } from './workbenchCredential'

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

    test('web login accepts only the web token when enabled, and the CLI token when disabled', () => {
        expect(webLoginTokenMatches('web-token', 'cli-token', 'web-token', true)).toBe(true)
        expect(webLoginTokenMatches('web-token:field', 'cli-token', 'web-token', true)).toBe(true)
        expect(webLoginTokenMatches('cli-token', 'cli-token', 'web-token', true)).toBe(false)
        expect(webLoginTokenMatches('web-token', 'cli-token', null, true)).toBe(false)
        expect(webLoginTokenMatches('cli-token', 'cli-token', 'web-token', false)).toBe(true)
        expect(webLoginTokenMatches('web-token', 'cli-token', 'web-token', false)).toBe(false)
    })

    test('cli access stays on the CLI token with no expiry, and rejects the web token only when separated', () => {
        expect(cliLongTermTokenAllowed('cli-token', 'cli-token', null)).toBe(true)
        expect(cliLongTermTokenAllowed('other-token', 'cli-token', null)).toBe(false)
        expect(cliLongTermTokenAllowed('cli-token', 'cli-token', 'web-token')).toBe(true)
        expect(cliLongTermTokenAllowed('web-token', 'cli-token', 'web-token')).toBe(false)
        expect(cliLongTermTokenAllowed('web-token:field', 'cli-token', 'web-token')).toBe(false)
        expect(createDistinctWebToken('cli-token')).not.toBe('cli-token')
    })

    test('a reminder counts as sent only when one channel reports a delivery', async () => {
        expect(countDelivered(undefined)).toBe(0)
        expect(countDelivered(0)).toBe(0)
        expect(countDelivered({ sent: 0 })).toBe(0)
        expect(countDelivered({ sent: 2 })).toBe(2)
        expect(await deliverReminderToNamespaces([], async () => 1)).toBe(false)
        expect(await deliverReminderToNamespaces(['phone'], async () => 0)).toBe(false)
        expect(await deliverReminderToNamespaces(['phone'], async () => 1)).toBe(true)
    })
})
