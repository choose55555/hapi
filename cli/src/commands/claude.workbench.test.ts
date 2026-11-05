import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
    runner: vi.fn(async () => false),
    spawn: vi.fn(() => ({ unref: vi.fn() })),
    run: vi.fn(async () => {})
}))
vi.mock('@/runner/controlClient', () => ({ isRunnerRunningCurrentlyInstalledHappyVersion: mocks.runner }))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => {} }))
vi.mock('@/ui/tokenInit', () => ({ initializeToken: async () => {} }))
vi.mock('@/utils/autoStartServer', () => ({ maybeAutoStartServer: async () => {} }))
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawn }))
vi.mock('@/claude/runClaude', () => ({ runClaude: mocks.run }))
import { claudeCommand } from './claude'
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
describe('workbench runner opt-in', () => {
    it('keeps the upstream running-runner path when disabled', async () => {
        vi.stubEnv('HAPI_WORKBENCH_NO_RUNNER', '0')
        mocks.runner.mockResolvedValueOnce(true)
        await claudeCommand.run({ commandArgs: [] } as unknown as Parameters<typeof claudeCommand.run>[0])
        expect(mocks.runner).toHaveBeenCalledTimes(1)
        expect(mocks.spawn).not.toHaveBeenCalled()
        expect(mocks.run).toHaveBeenCalledTimes(1)
    })
    it.each(['1', '0', 'true', undefined])('NO_RUNNER=%s preserves command execution', async value => {
        vi.stubEnv('HAPI_WORKBENCH_NO_RUNNER', value)
        await claudeCommand.run({ commandArgs: [] } as unknown as Parameters<typeof claudeCommand.run>[0])
        expect(mocks.runner).toHaveBeenCalledTimes(value === '1' ? 0 : 1)
        expect(mocks.spawn).toHaveBeenCalledTimes(value === '1' ? 0 : 1)
        expect(mocks.run).toHaveBeenCalledTimes(1)
    })
})
