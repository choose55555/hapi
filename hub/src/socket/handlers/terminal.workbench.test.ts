import { afterEach, describe, expect, it } from 'bun:test'
import { registerTerminalHandlers } from './terminal'

const original = process.env.HAPI_WORKBENCH_NO_SHELL
afterEach(() => {
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
    else process.env.HAPI_WORKBENCH_NO_SHELL = original
})
describe('hub browser terminal boundary', () => {
    for (const value of [undefined, '', '0', 'true', '01', '1']) {
        it(`handles terminal input with flag ${String(value)}`, () => {
            if (value === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
            else process.env.HAPI_WORKBENCH_NO_SHELL = value
            const handlers = new Map<string, (data: unknown) => void>()
            const emitted: Array<[string, unknown]> = []
            const forwarded: string[] = []
            const cli = { id: 'cli', data: { namespace: 'n' }, emit: (event: string) => forwarded.push(event) }
            const socket = {
                id: 'web', data: { namespace: 'n' },
                on: (event: string, fn: (data: unknown) => void) => handlers.set(event, fn),
                emit: (event: string, payload: unknown) => emitted.push([event, payload]),
                join: () => {}, leave: () => {}
            }
            const registry = {
                get: () => ({ terminalId: 't', sessionId: 's', socketId: 'web', cliSocketId: 'cli' }),
                register: () => ({ terminalId: 't', sessionId: 's', socketId: 'web', cliSocketId: 'cli' }),
                markActivity: () => {}, countForSocket: () => 0, countForSession: () => 0
            }
            const deps = {
                io: { of: () => ({ sockets: new Map([['cli', cli]]),
                    adapter: { rooms: new Map([['session:s', new Set(['cli'])]]) } }) },
                getSession: () => ({ active: true, namespace: 'n' }),
                terminalRegistry: registry, maxTerminalsPerSocket: 4, maxTerminalsPerSession: 4
            }
            registerTerminalHandlers(socket as unknown as Parameters<typeof registerTerminalHandlers>[0],
                deps as unknown as Parameters<typeof registerTerminalHandlers>[1])
            handlers.get('terminal:create')!({ sessionId: 's', terminalId: 't', cols: 80, rows: 24 })
            handlers.get('terminal:write')!({ terminalId: 't', data: 'command' })
            handlers.get('terminal:resize')!({ terminalId: 't', cols: 80, rows: 24 })
            handlers.get('agent-terminal:input')!({ sessionId: 's', data: '!command\r' })
            if (value === '1') {
                expect(forwarded).toEqual([])
                expect(emitted).toHaveLength(4)
                for (const [event, payload] of emitted) {
                    expect(event).toBe('terminal:error')
                    expect((payload as { message: string }).message).toContain('工作台已禁用')
                }
            } else {
                expect(forwarded).toEqual(['terminal:open', 'terminal:write', 'terminal:resize', 'agent-terminal:input'])
                expect(emitted).toEqual([])
            }
        })
    }
})
