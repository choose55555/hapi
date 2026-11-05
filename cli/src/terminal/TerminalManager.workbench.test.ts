import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalManager } from './TerminalManager'

const original = process.env.HAPI_WORKBENCH_NO_SHELL
afterEach(() => {
    vi.unstubAllGlobals()
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
    else process.env.HAPI_WORKBENCH_NO_SHELL = original
})

describe('workbench web terminal restriction', () => {
    it('rejects creation, reconnect, input and resize without touching a PTY', () => {
        process.env.HAPI_WORKBENCH_NO_SHELL = '1'
        // A red run must never start a real shell.
        const spawn = vi.fn(() => { throw new Error('unexpected shell spawn') })
        vi.stubGlobal('Bun', { spawn })
        const errors: string[] = []
        let paths = 0
        let ready = 0
        const manager = new TerminalManager({
            sessionId: 's', getSessionPath: () => { paths++; return null },
            onReady: () => { ready++ }, onOutput: () => {}, onExit: () => {},
            onError: (payload) => errors.push(payload.message)
        })
        // No existing entry: must reject before shell resolution or Bun.spawn.
        manager.create('new', 80, 24)
        // Simulate a PTY opened before the flag was enabled; no method may touch it.
        const forbidden = () => { throw new Error('existing PTY must not be touched') }
        const terminals = (manager as unknown as {
            terminals: Map<string, unknown>
        }).terminals
        terminals.set('existing', { terminal: { resize: forbidden, write: forbidden } })
        manager.create('existing', 80, 24)
        manager.write('existing', '!arbitrary command\r')
        manager.resize('existing', 80, 24)
        expect(paths).toBe(0)
        expect(spawn).not.toHaveBeenCalled()
        expect(ready).toBe(0)
        expect(errors).toHaveLength(4)
        for (const error of errors) expect(error).toContain('工作台已禁用')
        terminals.clear()
    })
    for (const value of [undefined, '', '0', 'true', '01']) {
        it(`keeps existing-terminal writes and reconnect for ${String(value)}`, () => {
            if (value === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
            else process.env.HAPI_WORKBENCH_NO_SHELL = value
            const writes: string[] = []
            let resizes = 0
            let ready = 0
            const manager = new TerminalManager({
                sessionId: 's', getSessionPath: () => null, idleTimeoutMs: -1,
                onReady: () => { ready++ }, onOutput: () => {}, onExit: () => {},
                onError: () => { throw new Error('unexpected terminal error') }
            })
            const terminals = (manager as unknown as { terminals: Map<string, unknown> }).terminals
            terminals.set('t', {
                terminalId: 't', terminal: { resize: () => { resizes++ }, write: (s: string) => writes.push(s) }
            })
            manager.create('t', 80, 24)
            manager.write('t', 'hello')
            expect(ready).toBe(1)
            expect(resizes).toBe(1)
            expect(writes).toEqual(['hello'])
            terminals.clear()
        })
    }
})
