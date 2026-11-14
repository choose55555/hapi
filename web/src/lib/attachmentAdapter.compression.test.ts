import { afterEach, expect, it, vi } from 'vitest'
import { createAttachmentAdapter } from './attachmentAdapter'
import { compressImageForUpload } from './compressImageForUpload'

vi.mock('./compressImageForUpload', () => ({ compressImageForUpload: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('uploads the compressed bytes with matching JPEG name, MIME and metadata', async () => {
    const original = new File(['original'], 'phone.heic', { type: 'image/heic' })
    const compressed = new File(['jpeg'], 'phone.jpg', { type: 'image/jpeg' })
    vi.mocked(compressImageForUpload).mockResolvedValue(compressed)
    class Reader {
        result = 'data:image/jpeg;base64,anBlZw=='
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        readAsDataURL(file: File) { expect(file).toBe(compressed); this.onload?.() }
    }
    vi.stubGlobal('FileReader', Reader)
    const uploadFile = vi.fn(async () => ({ success: true, path: '/uploads/phone.jpg' }))
    const adapter = createAttachmentAdapter({ uploadFile } as never, 'session-1')
    const emitted = []
    for await (const item of adapter.add({ file: original }) as AsyncIterable<unknown>) emitted.push(item)
    expect(compressImageForUpload).toHaveBeenCalledWith(original)
    expect(uploadFile).toHaveBeenCalledWith('session-1', 'phone.jpg', 'anBlZw==', 'image/jpeg')
    expect(emitted.at(-1)).toMatchObject({ name: 'phone.jpg', contentType: 'image/jpeg', file: compressed })
    const sent = await adapter.send(emitted.at(-1) as never)
    expect(sent.content).toEqual([{ type: 'text', text: expect.stringContaining('"filename":"phone.jpg","mimeType":"image/jpeg","size":4') }])
})
