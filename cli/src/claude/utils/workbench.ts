import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function workbenchEnabled(name: string): boolean {
    return process.env[name] === '1'
}

export const PERMISSION_LOCK_MESSAGE = '工作台权限模式由电脑启动参数决定，手机端不能切换。'

export function assertWorkbenchPermissionChangeAllowed(): void {
    if (workbenchEnabled('HAPI_WORKBENCH_PRESERVE_REMOTE')) {
        throw new Error(PERMISSION_LOCK_MESSAGE)
    }
}

type Settings = Record<string, unknown>

/**
 * Settings copies live in a fresh random child of the current user's TEMP.
 * On Windows that directory already inherits the per-user TEMP ACL (only this user,
 * SYSTEM and administrators), so no extra DACL work is done; on POSIX tighten to 0700.
 */
function restrictSettingsDirectory(directory: string): void {
    if (process.platform !== 'win32') {
        chmodSync(directory, 0o700)
    }
}

function parseSettings(text: string): Settings {
    let value: unknown
    try {
        value = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
        // Do not include settings contents (which may contain credentials) in errors.
        throw new Error('Invalid settings JSON; refusing to launch')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Settings must be a JSON object')
    }
    const settings = value as Settings
    if (settings.hooks !== undefined) {
        if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
            throw new Error('Settings hooks must be an object')
        }
        for (const entries of Object.values(settings.hooks)) {
            if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
                throw new Error('Settings hook events must contain arrays of objects')
            }
        }
    }
    return settings
}

/** Retain user keys; hook events are concatenated in source order, never replaced. */
function mergeSettings(left: Settings, right: Settings): Settings {
    const hooks: Record<string, unknown[]> = { ...(left.hooks as Record<string, unknown[]> | undefined) }
    for (const [event, entries] of Object.entries(right.hooks ?? {})) {
        hooks[event] = [...(hooks[event] ?? []), ...(entries as unknown[])]
    }
    return { ...left, ...right, ...(left.hooks !== undefined || right.hooks !== undefined ? { hooks } : {}) }
}

/**
 * Mutates argv only after all sources parse and the private copy is written.
 * Never writes a user settings file. Caller owns cleanup after child termination.
 * The disabled path performs no I/O and does not alter argv.
 */
export function mergeWorkbenchSettings(args: string[], hapiSettingsPath: string | undefined, cwd?: string): (() => void) | undefined {
    if (!workbenchEnabled('HAPI_WORKBENCH_MERGE_SETTINGS')) return undefined
    const baseDir = cwd ?? process.cwd()

    const forwarded: string[] = []
    let settings: Settings = {}
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--settings' || arg.startsWith('--settings=')) {
            const value = arg === '--settings' ? args[++i] : arg.slice('--settings='.length)
            if (!value || value.startsWith('--')) throw new Error('Missing --settings value; refusing to launch')
            // Claude accepts both JSON and filenames. Resolve filenames in child cwd.
            const text = value.trimStart().startsWith('{') ? value : readFileSync(resolve(baseDir, value), 'utf8')
            settings = mergeSettings(settings, parseSettings(text))
        } else {
            forwarded.push(arg)
        }
    }
    if (hapiSettingsPath) {
        settings = mergeSettings(settings, parseSettings(readFileSync(resolve(baseDir, hapiSettingsPath), 'utf8')))
    }

    const directory = mkdtempSync(join(tmpdir(), 'hapi-workbench-settings-'))
    const cleanup = () => rmSync(directory, { recursive: true, force: true })
    try {
        restrictSettingsDirectory(directory)
        const path = join(directory, 'settings.json')
        writeFileSync(path, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        const separator = forwarded.indexOf('--')
        forwarded.splice(separator < 0 ? forwarded.length : separator, 0, '--settings', path)
        args.splice(0, args.length, ...forwarded)
        return cleanup
    } catch (error) {
        cleanup()
        throw error
    }
}
