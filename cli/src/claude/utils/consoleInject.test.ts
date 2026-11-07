import { describe, expect, it, vi } from 'vitest'
import {
    CTRL_J_UNICODE_CHAR,
    CTRL_S_UNICODE_CHAR,
    ConsoleMessageInjector,
    DEFAULT_STASH_DELAY_MS,
    ENTER_UNICODE_CHAR,
    EVENT_TYPE_KEY_EVENT,
    INPUT_RECORD_BYTE_LENGTH,
    LEFT_CTRL_PRESSED,
    SC_J,
    SC_RETURN,
    SC_S,
    VK_J,
    VK_RETURN,
    VK_S,
    buildCtrlSRecords,
    buildMessageKeyRecords,
    buildTextAndEnterRecords,
    decodeInputRecords,
    encodeInputRecords,
    type ConsoleKeyRecord,
    type Kernel32ConsoleFfi
} from './consoleInject'

function createFakeFfi() {
    const events: string[] = []
    const writtenBatches: ConsoleKeyRecord[][] = []
    let nextHandle = 100n
    let openShouldFail = false
    let writeShouldFail = false

    const ffi: Kernel32ConsoleFfi = {
        openConin: vi.fn(() => {
            events.push('openConin')
            if (openShouldFail) {
                return -1n
            }
            return nextHandle++
        }),
        writeConsoleInput: vi.fn((_handle, recordBytes, recordCount) => {
            events.push(`write:${recordCount}`)
            if (writeShouldFail) {
                throw new Error('simulated WriteConsoleInputW failure')
            }
            const decoded = decodeInputRecords(recordBytes)
            expect(decoded).toHaveLength(recordCount)
            writtenBatches.push(decoded)
            return recordCount
        }),
        closeHandle: vi.fn(() => {
            events.push('closeHandle')
            return true
        })
    }

    return {
        ffi,
        events,
        writtenBatches,
        setOpenFail(value: boolean) {
            openShouldFail = value
        },
        setWriteFail(value: boolean) {
            writeShouldFail = value
        }
    }
}

describe('consoleInject key sequence builders', () => {
    it('builds Ctrl+S at start, UTF-16 code units in body, Enter at end, and no trailing keys', () => {
        const text = '你好A'
        const records = buildMessageKeyRecords(text)

        // 2 (Ctrl+S) + 3 * 2 (3 BMP chars) + 2 (Enter) = 10 records
        expect(records).toHaveLength(10)

        // 1. Ctrl+S keyDown + keyUp at start
        expect(records[0]).toEqual({
            keyDown: true,
            repeatCount: 1,
            virtualKeyCode: VK_S,
            virtualScanCode: SC_S,
            unicodeChar: CTRL_S_UNICODE_CHAR,
            controlKeyState: LEFT_CTRL_PRESSED
        })
        expect(records[1]).toEqual({
            keyDown: false,
            repeatCount: 1,
            virtualKeyCode: VK_S,
            virtualScanCode: SC_S,
            unicodeChar: CTRL_S_UNICODE_CHAR,
            controlKeyState: LEFT_CTRL_PRESSED
        })

        // 2. Body UTF-16 code units ('你', '好', 'A')
        expect(records[2]).toEqual({
            keyDown: true,
            repeatCount: 1,
            virtualKeyCode: 0,
            virtualScanCode: 0,
            unicodeChar: '你'.charCodeAt(0),
            controlKeyState: 0
        })
        expect(records[3]).toEqual({
            keyDown: false,
            repeatCount: 1,
            virtualKeyCode: 0,
            virtualScanCode: 0,
            unicodeChar: '你'.charCodeAt(0),
            controlKeyState: 0
        })
        expect(records[4].unicodeChar).toBe('好'.charCodeAt(0))
        expect(records[5].unicodeChar).toBe('好'.charCodeAt(0))
        expect(records[6].unicodeChar).toBe('A'.charCodeAt(0))
        expect(records[7].unicodeChar).toBe('A'.charCodeAt(0))

        // 3. Enter at the very end, with no extra keys after Enter
        expect(records[8]).toEqual({
            keyDown: true,
            repeatCount: 1,
            virtualKeyCode: VK_RETURN,
            virtualScanCode: SC_RETURN,
            unicodeChar: ENTER_UNICODE_CHAR,
            controlKeyState: 0
        })
        expect(records[9]).toEqual({
            keyDown: false,
            repeatCount: 1,
            virtualKeyCode: VK_RETURN,
            virtualScanCode: SC_RETURN,
            unicodeChar: ENTER_UNICODE_CHAR,
            controlKeyState: 0
        })
    })

    it('converts LF, CRLF, and CR newlines into Ctrl+J (0x0A, VK 0x4A, LEFT_CTRL_PRESSED) before final Enter', () => {
        const records = buildMessageKeyRecords('a\nb\r\nc\rd')

        // Ctrl+S (2) + 'a'(2) + '\n'(2) + 'b'(2) + '\n'(2) + 'c'(2) + '\n'(2) + 'd'(2) + Enter(2) = 18
        expect(records).toHaveLength(18)

        for (const newlineIndex of [4, 8, 12]) {
            expect(records[newlineIndex]).toEqual({
                keyDown: true,
                repeatCount: 1,
                virtualKeyCode: VK_J,
                virtualScanCode: SC_J,
                unicodeChar: CTRL_J_UNICODE_CHAR,
                controlKeyState: LEFT_CTRL_PRESSED
            })
            expect(records[newlineIndex + 1]).toEqual({
                keyDown: false,
                repeatCount: 1,
                virtualKeyCode: VK_J,
                virtualScanCode: SC_J,
                unicodeChar: CTRL_J_UNICODE_CHAR,
                controlKeyState: LEFT_CTRL_PRESSED
            })
        }

        // Final pair is Enter
        expect(records[16].virtualKeyCode).toBe(VK_RETURN)
        expect(records[16].unicodeChar).toBe(ENTER_UNICODE_CHAR)
        expect(records[17].virtualKeyCode).toBe(VK_RETURN)
        expect(records[17].keyDown).toBe(false)
    })

    it('splits non-BMP characters into UTF-16 high and low surrogate key pairs in order', () => {
        const emoji = '😀' // U+1F600 -> high surrogate 0xD83D, low surrogate 0xDE00
        const high = emoji.charCodeAt(0)
        const low = emoji.charCodeAt(1)
        expect(high).toBe(0xd83d)
        expect(low).toBe(0xde00)

        const records = buildMessageKeyRecords(emoji)
        // Ctrl+S (2) + high surrogate (2) + low surrogate (2) + Enter (2) = 8
        expect(records).toHaveLength(8)

        expect(records[2]).toEqual({
            keyDown: true,
            repeatCount: 1,
            virtualKeyCode: 0,
            virtualScanCode: 0,
            unicodeChar: 0xd83d,
            controlKeyState: 0
        })
        expect(records[3]).toEqual({
            keyDown: false,
            repeatCount: 1,
            virtualKeyCode: 0,
            virtualScanCode: 0,
            unicodeChar: 0xd83d,
            controlKeyState: 0
        })
        expect(records[4]).toEqual({
            keyDown: true,
            repeatCount: 1,
            virtualKeyCode: 0,
            virtualScanCode: 0,
            unicodeChar: 0xde00,
            controlKeyState: 0
        })
        expect(records[5]).toEqual({
            keyDown: false,
            repeatCount: 1,
            virtualKeyCode: 0,
            virtualScanCode: 0,
            unicodeChar: 0xde00,
            controlKeyState: 0
        })
    })

    it('packs each INPUT_RECORD into the exact 20-byte Win32 binary layout', () => {
        const ctrlS = buildCtrlSRecords()
        const encoded = encodeInputRecords(ctrlS)
        expect(encoded.byteLength).toBe(2 * INPUT_RECORD_BYTE_LENGTH)

        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
        // Record 0 (Ctrl+S keyDown)
        expect(view.getUint16(0, true)).toBe(EVENT_TYPE_KEY_EVENT)
        expect(view.getUint16(2, true)).toBe(0)
        expect(view.getInt32(4, true)).toBe(1)
        expect(view.getUint16(8, true)).toBe(1)
        expect(view.getUint16(10, true)).toBe(VK_S)
        expect(view.getUint16(12, true)).toBe(SC_S)
        expect(view.getUint16(14, true)).toBe(CTRL_S_UNICODE_CHAR)
        expect(view.getUint32(16, true)).toBe(LEFT_CTRL_PRESSED)

        // Round-trip decode matches input records
        expect(decodeInputRecords(encoded)).toEqual(ctrlS)
    })
})

describe('ConsoleMessageInjector', () => {
    it('writes Ctrl+S, waits ~400ms, then writes body + Enter with stubbed FFI', async () => {
        const fake = createFakeFfi()
        const sleepCalls: number[] = []

        const injector = new ConsoleMessageInjector({
            platform: 'win32',
            isProcessAlive: () => true,
            ffi: fake.ffi,
            sleep: async (ms) => {
                sleepCalls.push(ms)
                fake.events.push(`sleep:${ms}`)
            }
        })

        const result = await injector.enqueueMessage('ok')
        expect(result).toEqual({
            ok: true,
            recordsWritten: 8 // Ctrl+S (2) + 'o' (2) + 'k' (2) + Enter (2)
        })
        expect(sleepCalls).toEqual([DEFAULT_STASH_DELAY_MS])
        expect(fake.events).toEqual([
            'openConin',
            'write:2',
            `sleep:${DEFAULT_STASH_DELAY_MS}`,
            'write:6',
            'closeHandle'
        ])
        expect(fake.writtenBatches[0]).toEqual(buildCtrlSRecords())
        expect(fake.writtenBatches[1]).toEqual(buildTextAndEnterRecords('ok'))
    })

    it('serializes multiple queued messages so one finishes completely before the next starts', async () => {
        const fake = createFakeFfi()
        const injector = new ConsoleMessageInjector({
            platform: 'win32',
            isProcessAlive: () => true,
            ffi: fake.ffi,
            stashDelayMs: 50,
            sleep: async (ms) => {
                fake.events.push(`sleep:${ms}`)
            }
        })

        const [first, second] = await Promise.all([
            injector.enqueueMessage('A'),
            injector.enqueueMessage('BC')
        ])

        expect(first).toEqual({ ok: true, recordsWritten: 6 })
        expect(second).toEqual({ ok: true, recordsWritten: 8 })
        expect(fake.events).toEqual([
            'openConin',
            'write:2',
            'sleep:50',
            'write:4',
            'closeHandle',
            'openConin',
            'write:2',
            'sleep:50',
            'write:6',
            'closeHandle'
        ])
    })

    it('defers writing while localPermissionBridge has pending requests and writes once settled', async () => {
        const fake = createFakeFfi()
        let pending = true
        let resolveIdle: (() => void) | null = null

        const injector = new ConsoleMessageInjector({
            platform: 'win32',
            isProcessAlive: () => true,
            hasPendingPermissions: () => pending,
            waitForPermissionsIdle: () =>
                new Promise<void>((resolve) => {
                    fake.events.push('waitForPermissionsIdle')
                    resolveIdle = resolve
                }),
            ffi: fake.ffi,
            stashDelayMs: 0,
            sleep: async () => {}
        })

        const injectPromise = injector.enqueueMessage('after-perm')
        await Promise.resolve()

        // Must not have opened or written CONIN$ while permission is pending
        expect(fake.ffi.openConin).not.toHaveBeenCalled()
        expect(fake.ffi.writeConsoleInput).not.toHaveBeenCalled()

        // Settle the pending permission
        pending = false
        resolveIdle?.()

        const result = await injectPromise
        expect(result.ok).toBe(true)
        expect(fake.events[0]).toBe('waitForPermissionsIdle')
        expect(fake.ffi.openConin).toHaveBeenCalledTimes(1)
        expect(fake.ffi.writeConsoleInput).toHaveBeenCalledTimes(2)
    })

    it('does not write to CONIN$ when the local Claude process has exited', async () => {
        const fake = createFakeFfi()
        const injector = new ConsoleMessageInjector({
            platform: 'win32',
            isProcessAlive: () => false,
            ffi: fake.ffi,
            stashDelayMs: 0,
            sleep: async () => {}
        })

        const result = await injector.enqueueMessage('should-not-write')
        expect(result).toEqual({
            ok: false,
            reason: 'process_exited',
            writeState: 'zero',
            message: 'Claude local process has already exited.'
        })
        expect(fake.ffi.openConin).not.toHaveBeenCalled()
        expect(fake.ffi.writeConsoleInput).not.toHaveBeenCalled()
    })

    it('stops before writing message body if process exits during the 400ms Ctrl+S stash wait', async () => {
        const fake = createFakeFfi()
        let alive = true

        const injector = new ConsoleMessageInjector({
            platform: 'win32',
            isProcessAlive: () => alive,
            ffi: fake.ffi,
            sleep: async () => {
                alive = false
            }
        })

        const result = await injector.enqueueMessage('abort-mid-stash')
        expect(result).toEqual({
            ok: false,
            reason: 'process_exited',
            writeState: 'uncertain',
            message: 'Claude local process exited before message body could be injected.'
        })
        // Only Ctrl+S (2 records) was written before the process died; body+Enter was NOT written
        expect(fake.writtenBatches).toHaveLength(1)
        expect(fake.writtenBatches[0]).toEqual(buildCtrlSRecords())
        expect(fake.ffi.closeHandle).toHaveBeenCalledTimes(1)
    })

    it('times out with zero writeState when permission wait expires before any key write', async () => {
        const fake = createFakeFfi()
        const injector = new ConsoleMessageInjector({
            platform: 'win32',
            isProcessAlive: () => true,
            hasPendingPermissions: () => true,
            waitForPermissionsIdle: (signal) =>
                new Promise<void>((resolve) => {
                    signal?.addEventListener('abort', () => resolve(), { once: true })
                }),
            permissionWaitTimeoutMs: 20,
            ffi: fake.ffi,
            stashDelayMs: 0,
            sleep: async () => {}
        })

        const result = await injector.enqueueMessage('timeout-pre-write')
        expect(result).toEqual({
            ok: false,
            reason: 'permission_timeout',
            writeState: 'zero',
            message: 'Timed out waiting for pending permission request before console write.'
        })
        expect(fake.ffi.openConin).not.toHaveBeenCalled()
        expect(fake.ffi.writeConsoleInput).not.toHaveBeenCalled()
    })

    it('times out with uncertain writeState when permission wait expires after Ctrl+S stash write', async () => {
        const fake = createFakeFfi()
        let pending = false
        const injector = new ConsoleMessageInjector({
            platform: 'win32',
            isProcessAlive: () => true,
            hasPendingPermissions: () => pending,
            waitForPermissionsIdle: (signal) =>
                new Promise<void>((resolve) => {
                    signal?.addEventListener('abort', () => resolve(), { once: true })
                }),
            permissionWaitTimeoutMs: 20,
            ffi: fake.ffi,
            stashDelayMs: 0,
            sleep: async () => {
                pending = true
            }
        })

        const result = await injector.enqueueMessage('timeout-post-stash')
        expect(result).toEqual({
            ok: false,
            reason: 'permission_timeout',
            writeState: 'uncertain',
            message: 'Timed out waiting for pending permission request after console stash write.'
        })
        expect(fake.writtenBatches).toHaveLength(1)
        expect(fake.writtenBatches[0]).toEqual(buildCtrlSRecords())
        expect(fake.ffi.closeHandle).toHaveBeenCalledTimes(1)
    })

    it('exits permission wait immediately when cancelled before write', async () => {
        const fake = createFakeFfi()
        let cancelled = false
        const injector = new ConsoleMessageInjector({
            platform: 'win32',
            isProcessAlive: () => true,
            hasPendingPermissions: () => true,
            waitForPermissionsIdle: (signal) =>
                new Promise<void>((resolve) => {
                    signal?.addEventListener('abort', () => resolve(), { once: true })
                }),
            permissionWaitTimeoutMs: 5000,
            ffi: fake.ffi,
            stashDelayMs: 0,
            sleep: async () => {}
        })

        const result = await injector.enqueueMessage('cancel-during-wait', undefined, {
            isCancelled: () => cancelled,
            pause: async () => {
                cancelled = true
            }
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason).toBe('aborted')
            expect(result.writeState).toBe('zero')
        }
        expect(fake.ffi.writeConsoleInput).not.toHaveBeenCalled()
    })
})
