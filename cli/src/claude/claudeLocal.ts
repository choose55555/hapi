import { mergeWorkbenchSettings, workbenchEnabled } from "./utils/workbench";
import { claudeChildEnv } from "./utils/childEnv";
import { mkdirSync } from "node:fs";
import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { appendMcpConfigArg } from "./utils/mcpConfig";
import { getSystemPrompt } from "./utils/systemPrompt";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
import { spawnWithTerminalGuard } from "@/utils/spawnWithTerminalGuard";
import { getHapiBlobsDir } from "@/constants/uploadPaths";
import { stripNewlinesForWindowsShellArg } from "@/utils/shellEscape";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import type { SessionModel } from "@/api/types";
import type { PermissionMode } from "./loop";

function withoutTrackedModelArgs(args: string[]): string[] {
    const filtered: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--model') {
            if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                i++;
            }
            continue;
        }
        if (arg.startsWith('--model=')) {
            continue;
        }
        filtered.push(arg);
    }

    return filtered;
}

function withoutSessionIdArgs(args: string[]): string[] {
    const filtered: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--session-id') {
            if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                i++;
            }
            continue;
        }
        if (arg.startsWith('--session-id=')) {
            continue;
        }
        filtered.push(arg);
    }

    return filtered;
}

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[]
    model?: SessionModel
    permissionMode?: PermissionMode
    allowedTools?: string[]
    hookSettingsPath: string
}) {

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });

    // Check if user passed explicit session control flags.
    const hasContinueFlag = opts.claudeArgs?.includes('--continue');
    const hasResumeFlag = opts.claudeArgs?.includes('--resume');
    const hasUserSessionControl = Boolean(hasContinueFlag || hasResumeFlag);

    // Determine session strategy:
    // - If resuming an existing session: use --resume (unless user already supplied session control)
    // - If starting fresh: let Claude create a new session ID (reported via SessionStart hook)
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    if (opts.abort.aborted) {
        logger.debug('[ClaudeLocal] Abort already signaled before spawn; skipping launch');
        return startFrom ?? null;
    }

    // Build args for Claude CLI
    const args: string[] = [];

    const shouldResume = Boolean(startFrom && !hasUserSessionControl);
    if (shouldResume) {
        // Resume existing session
        args.push('--resume', startFrom!);
    }

    args.push('--append-system-prompt', stripNewlinesForWindowsShellArg(getSystemPrompt()));

    const cleanupMcpConfig = appendMcpConfigArg(args, opts.mcpServers, {
        baseDir: projectDir
    });

    if (opts.allowedTools && opts.allowedTools.length > 0) {
        args.push('--allowedTools', opts.allowedTools.join(','));
    }

    // Once model state is available, it is authoritative over startup args.
    let claudeArgs = opts.model === undefined || !opts.claudeArgs
        ? opts.claudeArgs
        : withoutTrackedModelArgs(opts.claudeArgs);
    if (shouldResume && claudeArgs) {
        // A startup ID conflicts with --resume unless the user requests a fork.
        // Strip it only for our automatic resume; preserve explicit user controls.
        claudeArgs = withoutSessionIdArgs(claudeArgs);
    }
    if (claudeArgs) {
        args.push(...claudeArgs);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    // Omit default so Claude's own settings.json defaultMode still applies.
    if (opts.permissionMode && opts.permissionMode !== 'default') {
        args.push('--permission-mode', opts.permissionMode);
    }

    // Add hook settings for session tracking
    if (!workbenchEnabled('HAPI_WORKBENCH_MERGE_SETTINGS')) {
        args.push('--settings', opts.hookSettingsPath);
    }
    logger.debug(`[ClaudeLocal] Using hook settings: ${opts.hookSettingsPath}`);

    // Add blobs directory for file upload access
    args.push('--add-dir', getHapiBlobsDir());
    logger.debug(`[ClaudeLocal] Adding blobs directory: ${getHapiBlobsDir()}`);

    // Prepare environment variables
    // Note: Local mode uses global Claude installation
    //
    // SDK metadata extraction (extractSDKMetadata → query()) sets
    // CLAUDE_CODE_ENTRYPOINT='sdk-ts' on the current process. If leaked
    // into the local spawn, Claude Code thinks it was SDK-launched and
    // excludes the session from `claude --resume`. Destructure it out
    // so the child uses its own default entrypoint.
    const { CLAUDE_CODE_ENTRYPOINT: _, ...cleanEnv } = process.env
    const env = {
        ...cleanEnv,
        DISABLE_AUTOUPDATER: '1',
        ...opts.claudeEnvVars
    }

    if (workbenchEnabled('HAPI_WORKBENCH_MERGE_SETTINGS') || workbenchEnabled('HAPI_WORKBENCH_PRESERVE_REMOTE')) {
        logger.debug('[ClaudeLocal] Spawning Claude with workbench configuration (arguments redacted)');
    } else {
        logger.debug(`[ClaudeLocal] Spawning claude with args: ${JSON.stringify(args)}`);
    }

    // Get Claude executable path (absolute path on Windows for shell: false)
    const claudeCommand = getDefaultClaudeCodePath();
    logger.debug(`[ClaudeLocal] Using claude executable: ${claudeCommand}`);

    // Spawn the process. Create the settings copy only inside its cleanup scope.
    let cleanupSettings: (() => void) | undefined;
    const cleanupOnExit = () => cleanupSettings?.();
    try {
        cleanupSettings = mergeWorkbenchSettings(args, opts.hookSettingsPath, opts.path);
        if (cleanupSettings) process.once('exit', cleanupOnExit);
        await spawnWithTerminalGuard({
            command: claudeCommand,
            args,
            cwd: opts.path,
            env: claudeChildEnv(withBunRuntimeEnv(env, { allowBunBeBun: false })),
            signal: opts.abort,
            logLabel: 'ClaudeLocal',
            spawnName: 'claude',
            installHint: 'Claude CLI',
            includeCause: true,
            logExit: true,
            shell: false  // Use absolute path, no shell needed
        });
    } finally {
        if (cleanupSettings) process.removeListener('exit', cleanupOnExit);
        cleanupMcpConfig?.();
        cleanupSettings?.();
    }

    return startFrom ?? null;
}
