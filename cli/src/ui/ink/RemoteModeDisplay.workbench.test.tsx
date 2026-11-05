import React from 'react'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { render } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBuffer } from './messageBuffer'
vi.mock('./useSwitchControls', () => ({
    useSwitchControls: () => ({ confirmationMode: null, actionInProgress: null })
}))
import { RemoteModeDisplay } from './RemoteModeDisplay'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
})
describe('Windows terminal viewport', () => {
    for (const [columns, rows] of [[80, 24], [32, 10], [12, 6]]) {
        it('keeps wide messages within the viewport: ' + columns + 'x' + rows, async () => {
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
            const stdout = new PassThrough() as PassThrough & { columns: number; rows: number }
            stdout.columns = columns
            stdout.rows = rows
            const chunks: string[] = []
            stdout.on('data', chunk => chunks.push(String(chunk)))
            const messageBuffer = new MessageBuffer()
            messageBuffer.addMessage('中文宽字符'.repeat(40), 'assistant')
            const app = render(<RemoteModeDisplay messageBuffer={messageBuffer} onSwitchToLocal={() => {}} />, {
                stdout: stdout as any, stderr: stdout as any,
                stdin: new PassThrough() as any,
                debug: true, patchConsole: false, exitOnCtrlC: false,
            })
            try {
                await new Promise<void>(resolve => setImmediate(resolve))
                const frame = chunks.filter(chunk => chunk.includes('Remote Mode')).at(-1)
                expect(frame).toBeDefined()
                const lines = stripVTControlCharacters(frame!).trimEnd().split('\n')
                expect(lines.length).toBeLessThanOrEqual(rows)
                for (const line of lines) {
                    const cells = Array.from(line).reduce((sum, char) => sum + (/[\u3400-\u9fff]/u.test(char) ? 2 : 1), 0)
                    expect(cells).toBeLessThanOrEqual(columns)
                }
            } finally {
                app.unmount()
                stdout.destroy()
            }
        })
    }
})
