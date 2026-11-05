import { afterEach, describe, expect, it } from 'vitest'
import { ApiSessionClient } from './apiSession'

const original = process.env.HAPI_WORKBENCH_NO_SHELL
afterEach(() => {
    if (original === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
    else process.env.HAPI_WORKBENCH_NO_SHELL = original
})
describe('session raw agent terminal input', () => {
    for (const value of [undefined, '', '0', 'true', '01', '1']) {
        it(`handles raw keys with flag ${String(value)}`, () => {
            if (value === undefined) delete process.env.HAPI_WORKBENCH_NO_SHELL
            else process.env.HAPI_WORKBENCH_NO_SHELL = value
            let calls = 0
            const errors: unknown[] = []
            const client = Object.assign(Object.create(ApiSessionClient.prototype), {
                sessionId: 's', socket: { emit: (event: string, payload: unknown) => errors.push([event, payload]) }
            }) as ApiSessionClient
            client.setAgentTerminalControls({ resize: () => {}, sendKeys: () => { calls++ } })
            const target = client as unknown as {
                handleAgentTerminalInput?: (data: string) => void
                agentTerminalSendKeys: (data: string) => void
            }
            // Keep the old baseline runnable: its socket callback called the
            // stored control directly. A red must be the calls assertion below.
            if (target.handleAgentTerminalInput) target.handleAgentTerminalInput('!command\r')
            else target.agentTerminalSendKeys('!command\r')
            expect(calls).toBe(value === '1' ? 0 : 1)
            if (value === '1') {
                expect(JSON.stringify(errors)).toContain('工作台已禁用')
            } else expect(errors).toEqual([])
            client.setAgentTerminalControls(null)
        })
    }
})
