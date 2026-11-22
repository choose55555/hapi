/**
 * Candidate pure helper for cli/src/claude/runClaude.ts (Bug 3: stable naming).
 *
 * 1. Allows workbench launchers to pass an explicit fixed session name via
 *    HAPI_SESSION_FIXED_NAME (e.g. "00_前台") which locks titleLocked=true and
 *    prevents UIA terminal-tab polling from overwriting it.
 * 2. Allows disabling UIA tab-name guessing completely on unlocked windows via
 *    HAPI_DISABLE_TERMINAL_TAB_GUESS=1.
 */

export const FIXED_SESSION_NAME_ENV = 'HAPI_SESSION_FIXED_NAME'
export const DISABLE_TERMINAL_TAB_GUESS_ENV = 'HAPI_DISABLE_TERMINAL_TAB_GUESS'
export const FIXED_SESSION_NAME_SOURCE = 'fixed'

export interface SessionNameMetadata {
    name?: string
    nameSource?: string
    titleLocked?: boolean
    [key: string]: unknown
}

export function resolveFixedSessionNameFromEnv(
    env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
    const raw = env[FIXED_SESSION_NAME_ENV]
    if (typeof raw !== 'string') return null
    const cleaned = raw.trim()
    return cleaned.length > 0 ? cleaned : null
}

export function isTerminalTabGuessDisabledFromEnv(
    env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
    const raw = env[DISABLE_TERMINAL_TAB_GUESS_ENV]?.trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes'
}

export function applyFixedSessionNameMetadata<T extends SessionNameMetadata>(
    metadata: T,
    fixedName: string | null
): T {
    if (!fixedName) return metadata
    // Respect an existing user-locked title on reopened sessions.
    if (metadata.titleLocked && metadata.name && metadata.nameSource !== FIXED_SESSION_NAME_SOURCE) {
        return metadata
    }
    if (
        metadata.name === fixedName
        && metadata.nameSource === FIXED_SESSION_NAME_SOURCE
        && metadata.titleLocked === true
    ) {
        return metadata
    }
    return {
        ...metadata,
        name: fixedName,
        nameSource: FIXED_SESSION_NAME_SOURCE,
        titleLocked: true
    }
}

export function canApplyTerminalTabName(metadata: SessionNameMetadata | null | undefined): boolean {
    if (!metadata) return true
    if (metadata.titleLocked === true) return false
    if (metadata.nameSource === FIXED_SESSION_NAME_SOURCE) return false
    return true
}
