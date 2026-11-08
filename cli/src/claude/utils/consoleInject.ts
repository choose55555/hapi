import { logger } from '@/ui/logger'

export const EVENT_TYPE_KEY_EVENT = 0x0001
export const INPUT_RECORD_BYTE_LENGTH = 20
export const MAX_RECORDS_PER_WRITE = 1024
export const DEFAULT_STASH_DELAY_MS = 400
export const DEFAULT_PERMISSION_WAIT_TIMEOUT_MS = 30_000

export const GENERIC_READ = 0x80000000
export const GENERIC_WRITE = 0x40000000
export const FILE_SHARE_READ = 0x00000001
export const FILE_SHARE_WRITE = 0x00000002
export const OPEN_EXISTING = 3

export const VK_RETURN = 0x0d
export const SC_RETURN = 0x1c
export const VK_S = 0x53
export const SC_S = 0x1f
export const VK_J = 0x4a
export const SC_J = 0x24
export const LEFT_CTRL_PRESSED = 0x0008

export const CTRL_S_UNICODE_CHAR = 0x0013
export const CTRL_J_UNICODE_CHAR = 0x000a
export const ENTER_UNICODE_CHAR = 0x000d

export interface ConsoleKeyRecord {
    keyDown: boolean
    repeatCount: number
    virtualKeyCode: number
    virtualScanCode: number
    unicodeChar: number
    controlKeyState: number
}

export type ConsoleHandle = number | bigint

export interface Kernel32ConsoleFfi {
    openConin(): ConsoleHandle
    writeConsoleInput(handle: ConsoleHandle, recordBytes: Uint8Array, recordCount: number): number
    closeHandle(handle: ConsoleHandle): boolean
}

export type ConsoleInjectFailureReason =
    | 'not_windows'
    | 'process_exited'
    | 'aborted'
    | 'permission_timeout'
    | 'open_conin_failed'
    | 'write_failed'

export type ConsoleInjectResult =
    | {
        ok: true
        recordsWritten: number
    }
    | {
        ok: false
        reason: ConsoleInjectFailureReason
        message: string
        writeState: 'zero' | 'uncertain'
    }

export interface ConsoleMessageInjectorOptions {
    isProcessAlive: () => boolean
    hasPendingPermissions?: () => boolean
    waitForPermissionsIdle?: (signal?: AbortSignal) => Promise<void>
    abortSignal?: AbortSignal
    stashDelayMs?: number
    permissionWaitTimeoutMs?: number
    timeoutMs?: number
    now?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    ffi?: Kernel32ConsoleFfi
    platform?: NodeJS.Platform
}

export interface ConsoleEnqueueOptions {
    signal?: AbortSignal
    isCancelled?: () => boolean
    permissionWaitTimeoutMs?: number
    timeoutMs?: number
    now?: () => number
    pause?: () => Promise<void>
}

export function createKeyRecord(
    keyDown: boolean,
    virtualKeyCode: number,
    virtualScanCode: number,
    unicodeChar: number,
    controlKeyState = 0,
    repeatCount = 1
): ConsoleKeyRecord {
    return {
        keyDown,
        repeatCount: repeatCount & 0xffff,
        virtualKeyCode: virtualKeyCode & 0xffff,
        virtualScanCode: virtualScanCode & 0xffff,
        unicodeChar: unicodeChar & 0xffff,
        controlKeyState: controlKeyState >>> 0
    }
}

export function createKeyPair(
    virtualKeyCode: number,
    virtualScanCode: number,
    unicodeChar: number,
    controlKeyState = 0
): [ConsoleKeyRecord, ConsoleKeyRecord] {
    return [
        createKeyRecord(true, virtualKeyCode, virtualScanCode, unicodeChar, controlKeyState),
        createKeyRecord(false, virtualKeyCode, virtualScanCode, unicodeChar, controlKeyState)
    ]
}

export function buildCtrlSRecords(): ConsoleKeyRecord[] {
    return createKeyPair(VK_S, SC_S, CTRL_S_UNICODE_CHAR, LEFT_CTRL_PRESSED)
}

export function buildEnterRecords(): ConsoleKeyRecord[] {
    return createKeyPair(VK_RETURN, SC_RETURN, ENTER_UNICODE_CHAR, 0)
}

export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function buildTextKeyRecords(text: string): ConsoleKeyRecord[] {
    const normalized = normalizeLineEndings(text)
    const records: ConsoleKeyRecord[] = []

    for (let i = 0; i < normalized.length; i++) {
        const codeUnit = normalized.charCodeAt(i)
        if (codeUnit === CTRL_J_UNICODE_CHAR) {
            records.push(...createKeyPair(VK_J, SC_J, CTRL_J_UNICODE_CHAR, LEFT_CTRL_PRESSED))
        } else {
            records.push(...createKeyPair(0, 0, codeUnit, 0))
        }
    }

    return records
}

export function buildTextAndEnterRecords(text: string): ConsoleKeyRecord[] {
    const records = buildTextKeyRecords(text)
    records.push(...buildEnterRecords())
    return records
}

export function buildMessageKeyRecords(text: string): ConsoleKeyRecord[] {
    return [...buildCtrlSRecords(), ...buildTextAndEnterRecords(text)]
}

/**
 * Pack ConsoleKeyRecord items into Win32 INPUT_RECORD binary layout (20 bytes per record, little-endian):
 *   offset 0  (u16): EventType = KEY_EVENT (0x0001)
 *   offset 2  (u16): alignment padding (0)
 *   offset 4  (i32): bKeyDown (1 or 0)
 *   offset 8  (u16): wRepeatCount (1)
 *   offset 10 (u16): wVirtualKeyCode
 *   offset 12 (u16): wVirtualScanCode
 *   offset 14 (u16): uChar.UnicodeChar (UTF-16LE code unit)
 *   offset 16 (u32): dwControlKeyState
 */
export function encodeInputRecords(records: readonly ConsoleKeyRecord[]): Uint8Array {
    const buffer = new ArrayBuffer(records.length * INPUT_RECORD_BYTE_LENGTH)
    const view = new DataView(buffer)

    for (let i = 0; i < records.length; i++) {
        const record = records[i]
        const base = i * INPUT_RECORD_BYTE_LENGTH
        view.setUint16(base + 0, EVENT_TYPE_KEY_EVENT, true)
        view.setUint16(base + 2, 0, true)
        view.setInt32(base + 4, record.keyDown ? 1 : 0, true)
        view.setUint16(base + 8, record.repeatCount, true)
        view.setUint16(base + 10, record.virtualKeyCode, true)
        view.setUint16(base + 12, record.virtualScanCode, true)
        view.setUint16(base + 14, record.unicodeChar, true)
        view.setUint32(base + 16, record.controlKeyState, true)
    }

    return new Uint8Array(buffer)
}

export function decodeInputRecords(bytes: Uint8Array): ConsoleKeyRecord[] {
    if (bytes.byteLength % INPUT_RECORD_BYTE_LENGTH !== 0) {
        throw new Error(`Invalid INPUT_RECORD buffer length: ${bytes.byteLength}`)
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = bytes.byteLength / INPUT_RECORD_BYTE_LENGTH
    const records: ConsoleKeyRecord[] = []

    for (let i = 0; i < count; i++) {
        const base = i * INPUT_RECORD_BYTE_LENGTH
        const eventType = view.getUint16(base + 0, true)
        if (eventType !== EVENT_TYPE_KEY_EVENT) {
            throw new Error(`Unexpected INPUT_RECORD EventType at index ${i}: 0x${eventType.toString(16)}`)
        }
        records.push({
            keyDown: view.getInt32(base + 4, true) !== 0,
            repeatCount: view.getUint16(base + 8, true),
            virtualKeyCode: view.getUint16(base + 10, true),
            virtualScanCode: view.getUint16(base + 12, true),
            unicodeChar: view.getUint16(base + 14, true),
            controlKeyState: view.getUint32(base + 16, true)
        })
    }

    return records
}

export function isInvalidConsoleHandle(handle: ConsoleHandle | null | undefined): boolean {
    if (handle === null || handle === undefined) {
        return true
    }
    if (typeof handle === 'bigint') {
        return handle === 0n || handle === -1n || handle === 0xffffffffffffffffn
    }
    return !Number.isFinite(handle) || handle <= 0 || handle === -1
}

function encodeNullTerminatedUtf16Le(text: string): Uint16Array {
    const out = new Uint16Array(text.length + 1)
    for (let i = 0; i < text.length; i++) {
        out[i] = text.charCodeAt(i)
    }
    out[text.length] = 0
    return out
}

let cachedBunKernel32Ffi: Kernel32ConsoleFfi | null = null

export function getDefaultKernel32ConsoleFfi(): Kernel32ConsoleFfi {
    if (cachedBunKernel32Ffi) {
        return cachedBunKernel32Ffi
    }

    // Lazy-load bun:ffi so unit tests can run under Node/Vitest with a stubbed FFI implementation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bunFfi = require('bun:ffi') as {
        dlopen: (
            library: string,
            symbols: Record<string, { args: unknown[]; returns: unknown }>
        ) => {
            symbols: {
                CreateFileW: (
                    lpFileName: unknown,
                    dwDesiredAccess: number,
                    dwShareMode: number,
                    lpSecurityAttributes: bigint,
                    dwCreationDisposition: number,
                    dwFlagsAndAttributes: number,
                    hTemplateFile: bigint
                ) => bigint
                WriteConsoleInputW: (
                    hConsoleInput: bigint,
                    lpBuffer: unknown,
                    nLength: number,
                    lpNumberOfEventsWritten: unknown
                ) => number
                CloseHandle: (hObject: bigint) => number
            }
        }
        FFIType: {
            ptr: unknown
            u32: unknown
            i32: unknown
            i64: unknown
        }
        ptr: (buffer: ArrayBufferView) => unknown
    }

    const { dlopen, FFIType, ptr } = bunFfi
    const kernel32 = dlopen('kernel32.dll', {
        CreateFileW: {
            args: [
                FFIType.ptr,
                FFIType.u32,
                FFIType.u32,
                FFIType.i64,
                FFIType.u32,
                FFIType.u32,
                FFIType.i64
            ],
            returns: FFIType.i64
        },
        WriteConsoleInputW: {
            args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr],
            returns: FFIType.i32
        },
        CloseHandle: {
            args: [FFIType.i64],
            returns: FFIType.i32
        }
    })

    const coninPathBuffer = encodeNullTerminatedUtf16Le('CONIN$')

    cachedBunKernel32Ffi = {
        openConin(): ConsoleHandle {
            return kernel32.symbols.CreateFileW(
                ptr(coninPathBuffer),
                (GENERIC_READ | GENERIC_WRITE) >>> 0,
                (FILE_SHARE_READ | FILE_SHARE_WRITE) >>> 0,
                0n,
                OPEN_EXISTING,
                0,
                0n
            )
        },
        writeConsoleInput(handle: ConsoleHandle, recordBytes: Uint8Array, recordCount: number): number {
            const writtenOut = new Uint32Array(1)
            const ok = kernel32.symbols.WriteConsoleInputW(
                BigInt(handle),
                ptr(recordBytes),
                recordCount >>> 0,
                ptr(writtenOut)
            )
            if (!ok) {
                throw new Error('WriteConsoleInputW returned FALSE')
            }
            return writtenOut[0] ?? 0
        },
        closeHandle(handle: ConsoleHandle): boolean {
            return Boolean(kernel32.symbols.CloseHandle(BigInt(handle)))
        }
    }

    return cachedBunKernel32Ffi
}

export function writeRecordsChunked(
    ffi: Kernel32ConsoleFfi,
    handle: ConsoleHandle,
    records: readonly ConsoleKeyRecord[],
    chunkSize = MAX_RECORDS_PER_WRITE
): number {
    let totalWritten = 0
    for (let offset = 0; offset < records.length; offset += chunkSize) {
        const slice = records.slice(offset, offset + chunkSize)
        const encoded = encodeInputRecords(slice)
        const written = ffi.writeConsoleInput(handle, encoded, slice.length)
        if (written !== slice.length) {
            throw new Error(`WriteConsoleInputW short write: expected ${slice.length}, wrote ${written}`)
        }
        totalWritten += written
    }
    return totalWritten
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve()
    }
    if (signal?.aborted) {
        return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            if (signal) {
                signal.removeEventListener('abort', onAbort)
            }
            resolve()
        }, ms)

        const onAbort = () => {
            clearTimeout(timer)
            resolve()
        }

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true })
        }
    })
}

export class ConsoleMessageInjector {
    private writeMayHaveOccurred = false
    private serialChain: Promise<void> = Promise.resolve()

    private readonly options: ConsoleMessageInjectorOptions
    constructor(options: ConsoleMessageInjectorOptions) { this.options = options }

    enqueueMessage(
        text: string,
        beforeWrite?: () => boolean,
        enqueueOptions?: ConsoleEnqueueOptions
    ): Promise<ConsoleInjectResult> {
        const runNext = this.serialChain.then(
            () => this.runAttempt(text, beforeWrite, enqueueOptions),
            () => this.runAttempt(text, beforeWrite, enqueueOptions)
        )
        this.serialChain = runNext.then(
            () => undefined,
            () => undefined
        )
        return runNext
    }

    private async runAttempt(
        text: string,
        beforeWrite?: () => boolean,
        enqueueOptions?: ConsoleEnqueueOptions
    ): Promise<ConsoleInjectResult> {
        this.writeMayHaveOccurred = false
        const result = await this.injectSingleMessage(text, beforeWrite, enqueueOptions)
        return result.ok ? result : { ...result, writeState: this.writeMayHaveOccurred ? 'uncertain' : 'zero' }
    }

    private async waitIfPermissionsPending(
        enqueueOptions?: ConsoleEnqueueOptions
    ): Promise<'ok' | 'aborted' | 'cancelled' | 'process_exited' | 'permission_timeout'> {
        const { hasPendingPermissions, waitForPermissionsIdle, abortSignal } = this.options
        if (!hasPendingPermissions) {
            return 'ok'
        }
        const nowFn = this.options.now ?? enqueueOptions?.now ?? Date.now
        const timeoutMs =
            this.options.permissionWaitTimeoutMs ??
            this.options.timeoutMs ??
            enqueueOptions?.permissionWaitTimeoutMs ??
            enqueueOptions?.timeoutMs ??
            DEFAULT_PERMISSION_WAIT_TIMEOUT_MS
        const deadline = nowFn() + Math.max(0, timeoutMs)

        while (hasPendingPermissions()) {
            if (abortSignal?.aborted || enqueueOptions?.signal?.aborted) {
                return 'aborted'
            }
            if (enqueueOptions?.isCancelled?.()) {
                return 'cancelled'
            }
            if (!this.options.isProcessAlive()) {
                return 'process_exited'
            }
            if (nowFn() >= deadline) {
                return 'permission_timeout'
            }

            const waitController = new AbortController()
            const onOuterAbort = () => {
                if (!waitController.signal.aborted) {
                    waitController.abort()
                }
            }
            abortSignal?.addEventListener('abort', onOuterAbort, { once: true })
            enqueueOptions?.signal?.addEventListener('abort', onOuterAbort, { once: true })

            const idlePromise = waitForPermissionsIdle
                ? waitForPermissionsIdle(waitController.signal)
                : null

            const monitorPromise = (async () => {
                while (!waitController.signal.aborted && hasPendingPermissions()) {
                    if (abortSignal?.aborted || enqueueOptions?.signal?.aborted
                        || enqueueOptions?.isCancelled?.() || !this.options.isProcessAlive()) {
                        return
                    }
                    const remaining = deadline - nowFn()
                    if (remaining <= 0) {
                        return
                    }
                    if (enqueueOptions?.pause) {
                        await enqueueOptions.pause()
                    } else {
                        await defaultSleep(Math.min(remaining, 25), waitController.signal)
                    }
                }
            })()

            try {
                if (idlePromise) {
                    await Promise.race([idlePromise, monitorPromise])
                } else {
                    await monitorPromise
                }
            } finally {
                onOuterAbort()
                abortSignal?.removeEventListener('abort', onOuterAbort)
                enqueueOptions?.signal?.removeEventListener('abort', onOuterAbort)
            }
        }
        return 'ok'
    }

    private async injectSingleMessage(
        text: string,
        beforeWrite?: () => boolean,
        enqueueOptions?: ConsoleEnqueueOptions
    ): Promise<ConsoleInjectResult> {
        const platform = this.options.platform ?? process.platform
        if (platform !== 'win32') {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'not_windows',
                message: 'Console input injection is only supported on Windows.'
            }
        }

        if (this.options.abortSignal?.aborted || enqueueOptions?.signal?.aborted) {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'aborted',
                message: 'Local launcher session has already aborted.'
            }
        }

        if (enqueueOptions?.isCancelled?.()) {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'aborted',
                message: 'Queued message has already been cancelled.'
            }
        }

        if (!this.options.isProcessAlive()) {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'process_exited',
                message: 'Claude local process has already exited.'
            }
        }

        const preWriteWait = await this.waitIfPermissionsPending(enqueueOptions)

        if (preWriteWait === 'aborted' || this.options.abortSignal?.aborted || enqueueOptions?.signal?.aborted) {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'aborted',
                message: 'Local launcher session aborted while waiting for pending permission request.'
            }
        }

        if (preWriteWait === 'cancelled' || enqueueOptions?.isCancelled?.()) {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'aborted',
                message: 'Queued message cancelled while waiting for pending permission request.'
            }
        }

        if (preWriteWait === 'process_exited' || !this.options.isProcessAlive()) {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'process_exited',
                message: 'Claude local process exited while waiting for pending permission request.'
            }
        }

        if (preWriteWait === 'permission_timeout') {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'permission_timeout',
                message: 'Timed out waiting for pending permission request before console write.'
            }
        }

        let ffi: Kernel32ConsoleFfi
        try {
            ffi = this.options.ffi ?? getDefaultKernel32ConsoleFfi()
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            logger.debug('[consoleInject]: failed to initialize kernel32 FFI', error)
            return {
                ok: false,
                writeState: 'zero',
                reason: 'open_conin_failed',
                message: `Failed to initialize Windows console input FFI: ${detail}`
            }
        }

        let handle: ConsoleHandle
        try {
            handle = ffi.openConin()
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            logger.debug('[consoleInject]: CreateFileW(CONIN$) threw', error)
            return {
                ok: false,
                writeState: 'zero',
                reason: 'open_conin_failed',
                message: `Failed to open CONIN$: ${detail}`
            }
        }

        if (isInvalidConsoleHandle(handle)) {
            return {
                ok: false,
                writeState: 'zero',
                reason: 'open_conin_failed',
                message: 'CreateFileW("CONIN$") returned INVALID_HANDLE_VALUE.'
            }
        }

        // Account for every FFI call, including a short first write and an
        // exception whose native side effects cannot be proven absent.
        const countedFfi: Kernel32ConsoleFfi = {
            ...ffi,
            writeConsoleInput: (h, bytes, count) => {
                const previous = this.writeMayHaveOccurred
                this.writeMayHaveOccurred = true
                const written = ffi.writeConsoleInput(h, bytes, count)
                this.writeMayHaveOccurred = previous || written > 0
                return written
            }
        }
        const sleepFn = this.options.sleep ?? defaultSleep
        const stashDelayMs = this.options.stashDelayMs ?? DEFAULT_STASH_DELAY_MS

        try {
            if (this.options.abortSignal?.aborted || enqueueOptions?.signal?.aborted
                || enqueueOptions?.isCancelled?.() || !this.options.isProcessAlive()
                || this.options.hasPendingPermissions?.() || beforeWrite?.() === false) {
                return { ok: false, writeState: 'zero', reason: 'aborted',
                    message: 'Input gate closed before the first console write.' }
            }
            const ctrlSRecords = buildCtrlSRecords()
            const writtenCtrlS = writeRecordsChunked(countedFfi, handle, ctrlSRecords)

            await sleepFn(stashDelayMs, this.options.abortSignal)

            if (this.options.abortSignal?.aborted || enqueueOptions?.signal?.aborted || enqueueOptions?.isCancelled?.()) {
                return {
                    ok: false,
                    writeState: 'zero',
                    reason: 'aborted',
                    message: 'Local launcher session aborted before message body could be injected.'
                }
            }

            if (!this.options.isProcessAlive()) {
                return {
                    ok: false,
                    writeState: 'zero',
                    reason: 'process_exited',
                    message: 'Claude local process exited before message body could be injected.'
                }
            }

            const postStashWait = await this.waitIfPermissionsPending(enqueueOptions)

            if (postStashWait === 'aborted' || postStashWait === 'cancelled'
                || this.options.abortSignal?.aborted || enqueueOptions?.signal?.aborted
                || enqueueOptions?.isCancelled?.()) {
                return {
                    ok: false,
                    writeState: 'zero',
                    reason: 'aborted',
                    message: 'Local launcher session aborted while waiting for permission request.'
                }
            }

            if (postStashWait === 'process_exited' || !this.options.isProcessAlive()) {
                return {
                    ok: false,
                    writeState: 'zero',
                    reason: 'process_exited',
                    message: 'Claude local process exited while waiting for permission request.'
                }
            }

            if (postStashWait === 'permission_timeout') {
                return {
                    ok: false,
                    writeState: 'zero',
                    reason: 'permission_timeout',
                    message: 'Timed out waiting for pending permission request after console stash write.'
                }
            }

            const bodyAndEnterRecords = buildTextAndEnterRecords(text)
            const writtenBody = writeRecordsChunked(countedFfi, handle, bodyAndEnterRecords)

            return {
                ok: true,
                recordsWritten: writtenCtrlS + writtenBody
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            logger.debug('[consoleInject]: WriteConsoleInputW failed', error)
            return {
                ok: false,
                writeState: 'zero',
                reason: 'write_failed',
                message: `Failed to write message to console input: ${detail}`
            }
        } finally {
            try {
                ffi.closeHandle(handle)
            } catch (closeError) {
                logger.debug('[consoleInject]: CloseHandle failed', closeError)
            }
        }
    }
}
