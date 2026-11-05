import { shellJoin } from '@/modules/common/shellQuote'

/** Claude runs hooks with bash on Windows, unlike AGY's cmd runner.
 * Use the common subset of double-quoted bash/cmd argv syntax. Fail rather
 * than expand shell variables or silently change an unusual executable path.
 */
export function claudeHookCommand(parts: string[], platform: NodeJS.Platform = process.platform): string {
    if (platform !== 'win32') return shellJoin(parts, platform)
    return parts.map(part => {
        if (/[%!$`"\r\n]/.test(part)) {
            throw new Error('Windows Claude hook arguments contain unsupported shell characters')
        }
        return '"' + part.replace(/\\/g, '/') + '"'
    }).join(' ')
}
