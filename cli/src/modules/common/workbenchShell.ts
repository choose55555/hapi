// Applies only to browser/hub command transport, never to agent tool execution.
export const WORKBENCH_NO_SHELL_MESSAGE = '工作台已禁用手机/网页终端和直接命令执行；请通过 AI 会话提出任务。'

export function workbenchNoShell(): boolean {
    return process.env.HAPI_WORKBENCH_NO_SHELL === '1'
}

// NO_SHELL governs direct command transport. Fixed-purpose search, Git and
// file browsing remain available, with read-utility execution restrictions.
const COMMAND_RPC_METHODS = new Set(['bash'])

export function workbenchCommandRpcBlocked(method: string): boolean {
    return workbenchNoShell() && COMMAND_RPC_METHODS.has(method)
}
// Reject preprocessors before dispatch, including workspace-scoped searches.
export function assertWorkbenchReadRpcAllowed(method: string, params: unknown): void {
    if (!workbenchNoShell() || !['ripgrep', 'workspace-ripgrep'].includes(method)) return
    const args = (params as { args?: unknown } | null)?.args
    if (Array.isArray(args) && args.some(arg => typeof arg === 'string'
        && /^(--pre|--pre-glob)(=|$)/.test(arg))) {
        throw new Error('工作台不允许搜索时启动外部预处理程序；请去掉 --pre 或 --pre-glob 参数。')
    }
    // A RIPGREP_CONFIG_PATH file could inject --pre; the handler receives this same params object.
    if (Array.isArray(args) && args[0] !== '--no-config') args.unshift('--no-config')
}

export function workbenchGitArgs(args: string[]): string[] {
    if (!workbenchNoShell()) return args
    // These handlers construct argv themselves; diff may follow --literal-pathspecs.
    const diffIndex = args.indexOf('diff')
    const safe = [...args]
    if (diffIndex >= 0) safe.splice(diffIndex + 1, 0, '--no-ext-diff', '--no-textconv')
    return ['-c', 'core.fsmonitor=', ...safe]
}

