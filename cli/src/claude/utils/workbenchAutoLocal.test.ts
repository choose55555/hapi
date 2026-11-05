import { afterEach, describe, expect, it } from 'vitest'
import { shouldAutoReturnLocal } from './workbenchAutoLocal'
const original = process.env.HAPI_WORKBENCH_AUTO_LOCAL
afterEach(() => {
    if (original === undefined) delete process.env.HAPI_WORKBENCH_AUTO_LOCAL
    else process.env.HAPI_WORKBENCH_AUTO_LOCAL = original
})
describe('optional local return', () => {
    for (const value of [undefined, '', '0', 'true', '01', '1']) {
        it('requires exact 1: ' + String(value), () => {
            if (value === undefined) delete process.env.HAPI_WORKBENCH_AUTO_LOCAL
            else process.env.HAPI_WORKBENCH_AUTO_LOCAL = value
            expect(shouldAutoReturnLocal(true, false, 0, false)).toBe(value === '1')
        })
    }
    it('does not interrupt headless, pending, queued or exiting sessions', () => {
        process.env.HAPI_WORKBENCH_AUTO_LOCAL = '1'
        expect(shouldAutoReturnLocal(false, false, 0, false)).toBe(false)
        expect(shouldAutoReturnLocal(true, true, 0, false)).toBe(false)
        expect(shouldAutoReturnLocal(true, false, 1, false)).toBe(false)
        expect(shouldAutoReturnLocal(true, false, 0, true)).toBe(false)
    })
})

