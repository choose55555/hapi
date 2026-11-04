import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sdk from '@/claude/sdk'
import type { SDKMessage } from './sdk/types'
import { claudeRemote } from './claudeRemote'
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }))
vi.mock('./sdk/utils', () => ({ getDefaultClaudeCodePath: () => '/usr/bin/claude' }))
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('workbench remote launch', () => {
    it.each(['1', '0'])('preserves native permissions and startup config only with opt-in %s', async value => {
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
            claudeArgs: ['--system-prompt-file', 'system.txt', '--mcp-config=a.json', '--mcp-config', 'b.json', '--settings=s.json'],
            nextMessage: async () => calls++ === 0 ? { message: 'hello', mode: { permissionMode: 'bypassPermissions' } } : null,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            onReady: () => {}, isAborted: () => false, onSessionFound: () => {}, onMessage: () => {},
            setPermissionModeListener: fn => { listener = fn as typeof listener },
            onPermissionModeRejected: reject
        })
        const options = spy.mock.calls[0][0].options!
        expect(options.permissionMode).toBe(value === '1' ? 'bypassPermissions' : 'default')
        expect(options.additionalArgs).toEqual(value === '1'
            ? ['--system-prompt-file', 'system.txt', '--mcp-config=a.json', '--mcp-config', 'b.json', '--settings=s.json']
            : ['--settings=s.json'])
        if (value === '1') {
            expect(setMode).not.toHaveBeenCalled()
            expect(reject).toHaveBeenCalledWith('bypassPermissions', expect.stringContaining('手机端不能切换'))
        } else {
            expect(setMode).toHaveBeenCalledWith('auto')
        }
    })
})
