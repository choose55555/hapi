import { describe, expect, it } from 'vitest'
import { claudeChildEnv } from './childEnv'

describe('Claude child-only environment', () => {
    it('maps a proxy-free parent without mutating it and removes HAPI credentials', () => {
        const parent = Object.freeze({
            HAPI_WORKBENCH_CHILD_ENV: '1',
            HAPI_WORKBENCH_CHILD_HTTPS_PROXY: 'http://127.0.0.1:17898',
            HAPI_WORKBENCH_CHILD_HTTP_PROXY: 'http://127.0.0.1:17898',
            HAPI_WORKBENCH_CHILD_ALL_PROXY: 'http://127.0.0.1:17898',
            HAPI_WORKBENCH_CHILD_https_proxy: 'http://127.0.0.1:17898',
            HAPI_WORKBENCH_CHILD_NO_PROXY: 'localhost,127.0.0.1',
            CLI_API_TOKEN: 'fake-hapi-token', HAPI_EXTRA_HEADERS_JSON: '{"Authorization":"fake"}',
            HAPI_WORKBENCH_CHILD_CLI_API_TOKEN: 'fake-override', HAPI_AUTH_TOKEN: 'fake',
            HAPI_WORKBENCH_CHILD_HAPI_WORKBENCH_CHILD_NESTED: 'blocked',
            ANTHROPIC_API_KEY: 'fake-claude-key', PATH: '/bin'
        })
        const child = claudeChildEnv(parent, parent)
        for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy']) {
            const actualKey = process.platform === 'win32'
                ? Object.keys(child).find(name => name.toUpperCase() === key.toUpperCase())
                : key
            expect(actualKey && child[actualKey]).toBe('http://127.0.0.1:17898')
            expect(parent).not.toHaveProperty(key)
        }
        expect(child.NO_PROXY).toBe('localhost,127.0.0.1')
        expect(Object.keys(child).some(key => key.startsWith('HAPI_WORKBENCH_CHILD_'))).toBe(false)
        for (const key of ['CLI_API_TOKEN', 'HAPI_AUTH_TOKEN', 'HAPI_EXTRA_HEADERS_JSON']) expect(child[key]).toBeUndefined()
        expect(child.ANTHROPIC_API_KEY).toBe('fake-claude-key')
        expect(parent.CLI_API_TOKEN).toBe('fake-hapi-token')
    })

    it('overrides existing child values and preserves lower-case names on POSIX', () => {
        const child = claudeChildEnv({ HTTPS_PROXY: 'old', http_proxy: 'old' }, {
            HAPI_WORKBENCH_CHILD_ENV: '1',
            HAPI_WORKBENCH_CHILD_HTTPS_PROXY: 'http://127.0.0.1:17898',
            HAPI_WORKBENCH_CHILD_http_proxy: 'http://127.0.0.1:17898'
        })
        expect(child.HTTPS_PROXY).toBe('http://127.0.0.1:17898')
        expect(child.http_proxy).toBe('http://127.0.0.1:17898')
    })

    it.each([undefined, '', '0', 'true', '2'])('retains upstream inheritance for switch=%s', flag => {
        const parent = { HTTPS_PROXY: 'original', CLI_API_TOKEN: 'fake', HAPI_WORKBENCH_CHILD_ENV: flag,
            HAPI_WORKBENCH_CHILD_HTTPS_PROXY: 'ignored' }
        expect(claudeChildEnv(parent, parent)).toBe(parent)
    })
})
