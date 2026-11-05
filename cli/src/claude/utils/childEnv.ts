const CHILD_PREFIX = 'HAPI_WORKBENCH_CHILD_'

function isHapiCredential(name: string): boolean {
    return name === 'CLI_API_TOKEN' || name === 'HAPI_EXTRA_HEADERS_JSON'
        || /^HAPI_.*(?:TOKEN|SECRET|PASSWORD|KEY)(?:_|$)/.test(name)
}

/** Build only the Claude environment. Never install child overrides in process.env. */
export function claudeChildEnv(base: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    if (source.HAPI_WORKBENCH_CHILD_ENV !== '1') return base
    const child = { ...base }
    // Apply overrides last, including over claudeEnvVars and on Windows' case-insensitive env.
    for (const [name, value] of Object.entries(source)) {
        if (!name.startsWith(CHILD_PREFIX) || name === `${CHILD_PREFIX}ENV` || value === undefined) continue
        const target = name.slice(CHILD_PREFIX.length)
        if (!target || target.toUpperCase().startsWith(CHILD_PREFIX) || isHapiCredential(target.toUpperCase())) continue
        if (process.platform === 'win32') {
            for (const key of Object.keys(child)) {
                if (key.toUpperCase() === target.toUpperCase()) delete child[key]
            }
        }
        child[target] = value
    }
    // Filter after mapping too: prefixed credentials cannot bypass this boundary.
    for (const name of Object.keys(child)) {
        const normalized = name.toUpperCase()
        if (normalized.startsWith(CHILD_PREFIX) || isHapiCredential(normalized)) delete child[name]
    }
    return child
}
