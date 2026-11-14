const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
const MAX_EDGE = 2048

/** Preserve the original whenever decoding or JPEG conversion is unavailable. */
export async function compressImageForUpload(file: File): Promise<File> {
    if (!COMPRESSIBLE_TYPES.has(file.type.toLowerCase())) return file
    let url: string | undefined
    try {
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (!context || typeof Image === 'undefined' || typeof URL.createObjectURL !== 'function') return file
        url = URL.createObjectURL(file)
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const candidate = new Image()
            const timer = setTimeout(() => { candidate.onload = null; candidate.onerror = null; reject(new Error('Image decode timed out')) }, 3000)
            candidate.onload = () => { clearTimeout(timer); resolve(candidate) }
            candidate.onerror = () => { clearTimeout(timer); reject(new Error('Image decode failed')) }
            candidate.src = url!
        })
        const width = image.naturalWidth
        const height = image.naturalHeight
        if (!width || !height || Math.max(width, height) <= MAX_EDGE) return file
        const scale = MAX_EDGE / Math.max(width, height)
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        // JPEG has no alpha channel; composite transparent pixels on white.
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
        if (!blob || blob.type !== 'image/jpeg' || blob.size >= file.size) return file
        const stem = file.name.replace(/\.[^.]*$/, '') || 'image'
        return new File([blob], `${stem}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified })
    } catch {
        return file
    } finally {
        if (url !== undefined) URL.revokeObjectURL(url)
    }
}
