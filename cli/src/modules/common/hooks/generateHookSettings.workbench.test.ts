import { describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ text: '' }))
vi.mock('node:fs', () => ({
    mkdirSync: vi.fn(), writeFileSync: (_path: string, text: string) => { state.text = text },
    unlinkSync: vi.fn(), existsSync: () => false
}))
vi.mock('@/configuration', () => ({ configuration: { happyHomeDir: '/unused' } }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))
vi.mock('@/utils/spawnHappyCLI', () => ({
    getHappyCliCommand: () => ({ command: 'C:\\Program Files\\hapi.exe', args: ['hook-forwarder'] })
}))
vi.mock('./claudeHookCommand', () => ({
    claudeHookCommand: vi.fn(() => '"C:/Program Files/hapi.exe" "hook-forwarder"')
}))
import { generateHookSettingsFile } from './generateHookSettings'
import { claudeHookCommand } from './claudeHookCommand'
describe('hook settings use Claude-specific shell quoting', () => {
    it('applies the quoted command to every generated hook', () => {
        generateHookSettingsFile(1234, 'test-token', {
            filenamePrefix: 'test', logLabel: 'test', trackPermissionMode: true, includeLocalPermissions: true
        })
        expect(claudeHookCommand).toHaveBeenCalledWith(['C:\\Program Files\\hapi.exe', 'hook-forwarder'])
        const settings = JSON.parse(state.text)
        for (const groups of Object.values(settings.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
            for (const group of groups) for (const hook of group.hooks) {
                expect(hook.command).toBe('"C:/Program Files/hapi.exe" "hook-forwarder"')
            }
        }
    })
})
