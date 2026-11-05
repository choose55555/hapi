import { afterEach, describe, expect, it, vi } from 'vitest'
// Isolate user settings; the off baseline must contain attribution.
vi.mock('./claudeSettings', async (importOriginal) => ({
    ...await importOriginal<typeof import('./claudeSettings')>(),
    shouldIncludeCoAuthoredBy: () => true
}))
import { getSystemPrompt } from './systemPrompt'
const original = process.env.HAPI_WORKBENCH_NO_ATTRIBUTION
afterEach(() => {
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_ATTRIBUTION
    else process.env.HAPI_WORKBENCH_NO_ATTRIBUTION = original
})
describe('workbench attribution opt-out', () => {
    it('removes only the upstream credits block', () => {
        delete process.env.HAPI_WORKBENCH_NO_ATTRIBUTION
        const baseline = getSystemPrompt()
        const credits = /\n\nWhen making commit messages, you SHOULD also give credit to HAPI like so:[\s\S]*?Co-Authored-By: HAPI <noreply@hapi.run>/
        expect(baseline).toMatch(credits)
        process.env.HAPI_WORKBENCH_NO_ATTRIBUTION = '1'
        const result = getSystemPrompt()
        expect(result).toBe(baseline.replace(credits, ''))
        expect(result).not.toContain('via [HAPI]')
        expect(result).not.toContain('Co-Authored-By: HAPI')
        expect(result).toContain('mcp__hapi__change_title')
    })
    for (const value of [undefined, '', '0', 'true', '01']) {
        it(`preserves the full baseline for ${String(value)}`, () => {
            delete process.env.HAPI_WORKBENCH_NO_ATTRIBUTION
            const baseline = getSystemPrompt()
            if (value !== undefined) process.env.HAPI_WORKBENCH_NO_ATTRIBUTION = value
            expect(getSystemPrompt()).toBe(baseline)
        })
    }
})
