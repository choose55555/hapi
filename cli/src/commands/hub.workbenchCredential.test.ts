import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { hubCommand } from './hub'
import type { CommandContext } from './types'

const hub = vi.hoisted(() => ({
    revokeWorkbenchCredential: vi.fn<() => Promise<void>>(),
    printWorkbenchLoginQr: vi.fn<() => Promise<void>>(),
    startHub: vi.fn()
}))

// Do not load the Bun-only hub implementation into Vitest's Node runtime.
vi.mock('hapi-hub/startHub', () => hub)

beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit:1')
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

test('revoke-credential dispatches once and prints one credential-free result', async () => {
    hub.revokeWorkbenchCredential.mockResolvedValue(undefined)

    await hubCommand.run({ commandArgs: ['revoke-credential'] } as CommandContext)

    expect(hub.revokeWorkbenchCredential).toHaveBeenCalledTimes(1)
    expect(hub.revokeWorkbenchCredential).toHaveBeenCalledWith()
    expect(hub.printWorkbenchLoginQr).not.toHaveBeenCalled()
    expect(hub.startHub).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledWith(
        'Mobile login credential revoked. Start the hub to pair again.'
    )
    expect(console.error).not.toHaveBeenCalled()
    expect(process.exit).not.toHaveBeenCalled()
})

test('login-qr dispatches once and adds no output to the printer result', async () => {
    hub.printWorkbenchLoginQr.mockImplementation(async () => {
        console.log('test-only-printer-result')
    })

    await hubCommand.run({ commandArgs: ['login-qr'] } as CommandContext)

    expect(hub.printWorkbenchLoginQr).toHaveBeenCalledTimes(1)
    expect(hub.printWorkbenchLoginQr).toHaveBeenCalledWith()
    expect(hub.revokeWorkbenchCredential).not.toHaveBeenCalled()
    expect(hub.startHub).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledWith('test-only-printer-result')
    expect(console.error).not.toHaveBeenCalled()
    expect(process.exit).not.toHaveBeenCalled()
})

test.each(['revoke-credential', 'login-qr'])('%s rejects service options before dispatch', async command => {
    await expect(hubCommand.run({
        commandArgs: [command, '--port', '1']
    } as CommandContext)).rejects.toThrow('process.exit:1')

    expect(console.error).toHaveBeenCalledWith(
        expect.any(String), `${command} does not accept service options`
    )
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.log).not.toHaveBeenCalled()
    expect(hub.revokeWorkbenchCredential).not.toHaveBeenCalled()
    expect(hub.printWorkbenchLoginQr).not.toHaveBeenCalled()
    expect(hub.startHub).not.toHaveBeenCalled()
})

test.each(['revoke-credential', 'login-qr'])('%s reports implementation errors without starting the hub', async command => {
    const action = command === 'revoke-credential'
        ? hub.revokeWorkbenchCredential
        : hub.printWorkbenchLoginQr
    action.mockRejectedValue(new Error('test-only-command-failure'))

    await expect(hubCommand.run({
        commandArgs: [command]
    } as CommandContext)).rejects.toThrow('process.exit:1')

    expect(action).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenCalledWith()
    expect(console.error).toHaveBeenCalledWith(expect.any(String), 'test-only-command-failure')
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.log).not.toHaveBeenCalled()
    expect(hub.startHub).not.toHaveBeenCalled()
})
