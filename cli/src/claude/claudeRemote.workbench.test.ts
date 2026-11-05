import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sdk from '@/claude/sdk'
import type { SDKMessage } from './sdk/types'
import { claudeRemote } from './claudeRemote'
import * as sessionCheck from './utils/claudeCheckSession'
import { filterCatalogAffectingClaudeArgs } from './sdk/metadataExtractor'
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }))
vi.mock('./sdk/utils', () => ({ getDefaultClaudeCodePath: () => '/usr/bin/claude' }))
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('workbench remote launch', () => {
    it.each(['1', '0', undefined, '', 'true', '01'])('preserves native permissions and startup config only with opt-in %s', async value => {
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', value)
        let calls = 0
        let listener: ((mode: 'auto') => void) | null = null
        const setMode = vi.fn(async () => {})
        const reject = vi.fn()
        const spy = vi.spyOn(sdk, 'query').mockReturnValue({
            setPermissionMode: setMode,
            async *[Symbol.asyncIterator]() {
                listener?.('auto')
                yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
            }
        } as unknown as ReturnType<typeof sdk.query>)
        await claudeRemote({
            sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/hooks.json',
            claudeArgs: ['--system-prompt-file', 'system.txt', '--mcp-config=a.json', '--mcp-config', 'b.json', '--settings=s.json',
                '--strict-mcp-config', '--strict-mcp-config=true', '--fallback-model', 'backup-a', '--fallback-model=backup-b',
                '--session-id', '11111111-1111-4111-8111-111111111111', '--session-id=22222222-2222-4222-8222-222222222222', '--continue'],
            nextMessage: async () => calls++ === 0 ? { message: 'hello', mode: { permissionMode: 'bypassPermissions' } } : null,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            onReady: () => {}, isAborted: () => false, onSessionFound: () => {}, onMessage: () => {},
            setPermissionModeListener: fn => { listener = fn as typeof listener },
            onPermissionModeRejected: reject
        })
        const options = spy.mock.calls[0][0].options!
        expect(options.permissionMode).toBe(value === '1' ? 'bypassPermissions' : 'default')
        expect(options.additionalArgs).toEqual(value === '1'
            ? ['--system-prompt-file', 'system.txt', '--mcp-config=a.json', '--mcp-config', 'b.json', '--settings=s.json',
                '--strict-mcp-config', '--strict-mcp-config=true', '--fallback-model', 'backup-a', '--fallback-model=backup-b',
                '--session-id', '11111111-1111-4111-8111-111111111111', '--session-id=22222222-2222-4222-8222-222222222222']
            : ['--settings=s.json'])
        expect(options.continue).toBe(value === '1' ? true : undefined)
        expect(options.additionalArgs).not.toContain('--continue')
        if (value === '1') {
            expect(setMode).not.toHaveBeenCalled()
            expect(reject).toHaveBeenCalledWith('bypassPermissions', expect.stringContaining('手机端不能切换'))
        } else {
            expect(setMode).toHaveBeenCalledWith('auto')
        }
    })

    it('uses the known session on subsequent launches instead of continuing the latest session again', async () => {
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', '1')
        const spy = vi.spyOn(sdk, 'query').mockReturnValue({
            async *[Symbol.asyncIterator]() {}
        } as unknown as ReturnType<typeof sdk.query>)
        let calls = 0
        const sessionId = '11111111-1111-4111-8111-111111111111'
        await claudeRemote({
            sessionId, path: process.cwd(), allowedTools: [], hookSettingsPath: '/hooks.json',
            claudeArgs: ['--continue'],
            nextMessage: async () => calls++ === 0 ? { message: 'hello', mode: { permissionMode: 'default' } } : null,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            onReady: () => {}, isAborted: () => false, onSessionFound: () => {}, onMessage: () => {}
        })
        expect(spy.mock.calls[0][0].options?.resume).toBe(sessionId)
        expect(spy.mock.calls[0][0].options?.continue).toBeUndefined()
    })

    it('does not apply session identity or continuation to the metadata probe', () => {
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', '1')
        expect(filterCatalogAffectingClaudeArgs([
            '--session-id=11111111-1111-4111-8111-111111111111', '--continue', '--fallback-model=backup',
            '--strict-mcp-config', '--mcp-config=mcp.json'
        ])).toEqual(['--mcp-config=mcp.json'])
    })

    it.each(['1', '0', undefined, '', 'true', '01'])('resolves startup identity and fallback conflicts only with opt-in %s', async value => {
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', value)
        const sessionId = '11111111-1111-4111-8111-111111111111'
        const identityArgs = ['--session-id', 'new-session', '--session-id=another-session']
        const fallbackArgs = ['--fallback-model', 'startup-a', '--fallback-model=startup-b']
        const spy = vi.spyOn(sdk, 'query').mockReturnValue({
            async *[Symbol.asyncIterator]() {}
        } as unknown as ReturnType<typeof sdk.query>)
        const check = vi.spyOn(sessionCheck, 'claudeCheckSession')
        for (const scenario of ['known', 'explicit-resume', 'fork', 'invalid', 'fresh', 'message-clears-fallback'] as const) {
            check.mockReturnValue(scenario !== 'invalid')
            let calls = 0
            const known = scenario === 'known' || scenario === 'fork' || scenario === 'invalid'
            const extra = scenario === 'explicit-resume' ? ['--resume', sessionId]
                : scenario === 'fork' ? ['--fork-session'] : []
            await claudeRemote({
                sessionId: known ? sessionId : null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/hooks.json',
                claudeArgs: [...identityArgs, ...fallbackArgs, '--mcp-config=mcp.json', '--continue', ...extra],
                bootstrapMode: { permissionMode: 'default', fallbackModel: 'bootstrap-backup' },
                nextMessage: async () => calls++ === 0
                    ? { message: 'hello', mode: { permissionMode: 'default',
                        fallbackModel: scenario === 'message-clears-fallback' ? undefined : 'message-backup' } } : null,
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                onReady: () => {}, isAborted: () => false, onSessionFound: () => {}, onMessage: () => {}
            })
            const options = spy.mock.calls[spy.mock.calls.length - 1][0].options!
            expect(options.resume).toBe(['known', 'explicit-resume', 'fork'].includes(scenario) ? sessionId : undefined)
            expect(options.continue).toBe(value === '1' && ['fresh', 'message-clears-fallback'].includes(scenario) ? true : undefined)
            expect(options.fallbackModel).toBe(scenario === 'fork' ? 'bootstrap-backup'
                : scenario === 'message-clears-fallback' ? undefined : 'message-backup')
            expect(options.additionalArgs).toEqual(value === '1'
                ? [...(['known', 'explicit-resume'].includes(scenario) ? [] : identityArgs),
                    ...(scenario === 'message-clears-fallback' ? fallbackArgs : []), '--mcp-config=mcp.json']
                : [])
        }
    })

    it('propagates SDK startup failure instead of retrying without continue', async () => {
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', '1')
        const spy = vi.spyOn(sdk, 'query').mockImplementation(() => { throw new Error('SDK refused --continue; refusing to launch') })
        await expect(claudeRemote({
            sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/hooks.json',
            claudeArgs: ['--continue'],
            nextMessage: async () => ({ message: 'hello', mode: { permissionMode: 'default' } }),
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            onReady: () => {}, isAborted: () => false, onSessionFound: () => {}, onMessage: () => {}
        })).rejects.toThrow('SDK refused --continue; refusing to launch')
        expect(spy).toHaveBeenCalledTimes(1)
        expect(spy.mock.calls[0][0].options?.continue).toBe(true)
    })
})
