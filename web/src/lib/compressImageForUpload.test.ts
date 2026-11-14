import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressImageForUpload } from './compressImageForUpload'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function browser(width = 4096, height = 3072, size = 100, fail = false) {
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: revoke })
    class ImageMock {
        naturalWidth = width
        naturalHeight = height
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_value: string) { queueMicrotask(() => fail ? this.onerror?.() : this.onload?.()) }
    }
    vi.stubGlobal('Image', ImageMock)
    const drawImage = vi.fn()
    const context = { fillStyle: '', fillRect: vi.fn(), drawImage }
    const toBlob = vi.fn((callback: BlobCallback) => callback(new Blob(['x'.repeat(size)], { type: 'image/jpeg' })))
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    return { canvas, context, toBlob, revoke }
}

describe('compressImageForUpload', () => {
    it('falls back immediately when canvas decoding is unavailable', async () => {
        const b = browser()
        b.canvas.getContext.mockReturnValue(null as never)
        const file = new File(['original'], 'phone.jpg', { type: 'image/jpeg' })
        expect(await compressImageForUpload(file)).toBe(file)
        expect(URL.createObjectURL).not.toHaveBeenCalled()
    })

    it('falls back after 3 seconds when decoding never signals completion', async () => {
        vi.useFakeTimers()
        const b = browser()
        class SilentImage {
            onload = null
            onerror = null
            set src(_value: string) {}
        }
        vi.stubGlobal('Image', SilentImage)
        const file = new File(['original'], 'phone.heic', { type: 'image/heic' })
        const pending = compressImageForUpload(file)
        await vi.advanceTimersByTimeAsync(3000)
        expect(await pending).toBe(file)
        expect(b.revoke).toHaveBeenCalledWith('blob:test')
        expect(b.toBlob).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])('shrinks a large %s to JPEG before upload', async (type) => {
        const b = browser()
        const original = new File(['x'.repeat(1000)], 'photo.heic', { type, lastModified: 123 })
        const result = await compressImageForUpload(original)
        expect(result.size).toBe(100)
        expect(result.type).toBe('image/jpeg')
        expect(result.name).toBe('photo.jpg')
        expect(result.lastModified).toBe(123)
        expect([b.canvas.width, b.canvas.height]).toEqual([2048, 1536])
        expect(b.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8)
        expect(b.revoke).toHaveBeenCalledWith('blob:test')
    })
    it('keeps small images unchanged', async () => {
        const b = browser(800, 600)
        const file = new File(['original'], 'small.png', { type: 'image/png' })
        expect(await compressImageForUpload(file)).toBe(file)
        expect(b.toBlob).not.toHaveBeenCalled()
    })
    it.each(['image/gif', 'text/plain', 'application/pdf'])('keeps %s unchanged without decoding', async (type) => {
        const b = browser()
        const file = new File(['original'], 'input', { type })
        expect(await compressImageForUpload(file)).toBe(file)
        expect(URL.createObjectURL).not.toHaveBeenCalled()
        expect(b.toBlob).not.toHaveBeenCalled()
    })
    it('falls back on decode failure and releases the URL', async () => {
        const b = browser(4096, 3072, 100, true)
        const file = new File(['original'], 'broken.heic', { type: 'image/heic' })
        expect(await compressImageForUpload(file)).toBe(file)
        expect(b.revoke).toHaveBeenCalledWith('blob:test')
    })
    it('keeps the original when the encoded result is larger', async () => {
        browser()
        const file = new File(['tiny'], 'large.png', { type: 'image/png' })
        expect(await compressImageForUpload(file)).toBe(file)
    })
})
