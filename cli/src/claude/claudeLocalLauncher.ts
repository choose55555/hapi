import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { createSessionScanner } from "./utils/sessionScanner";
import { isClaudeChatVisibleMessage } from "./utils/chatVisibility";
import { BaseLocalLauncher } from "@/modules/common/launcher/BaseLocalLauncher";
import { applySessionTitleFallback } from './utils/sessionTitleFallback';
import { resolveClaudeLaunchModel } from './utils/claudeSettings';
import type { RawJSONLines } from './types';
import { ClaudeToolResultImages } from './utils/toolResultImages';
import { ConsoleMessageInjector, type Kernel32ConsoleFfi } from './utils/consoleInject';
import { createLocalMessageDrain } from './utils/localMessageDrain';


export interface ClaudeLocalLauncherDeps {
    platform?: NodeJS.Platform;
    ffi?: Kernel32ConsoleFfi;
    stashDelayMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// Local transcripts carry bare model ids and no context_window, so the web
// guesses 200k. When the TUI runs a "[1m]" model, stamp 1M on messages from
// that model only (subagents differ). Aliases ("opus[1m]") match "claude-opus-*".
function stampContextWindow(message: RawJSONLines, contextModel: string | null): void {
    if (message.type !== 'assistant' || !message.message?.usage || !contextModel || !/\[1m\]$/i.test(contextModel)) return;
    const base = contextModel.slice(0, -'[1m]'.length);
    const model = message.message.model;
    if (model === base || (!base.includes('-') && model?.startsWith(`claude-${base}-`))) {
        message.message.usage.context_window ??= 1_000_000;
    }
}

function isInterruptMarker(message: RawJSONLines): boolean {
    if (message.type !== 'user' || message.isSidechain) return false;
    const content = message.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    return Array.isArray(blocks) && blocks.some((block) =>
        block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[Request interrupted by user'));
}

export async function claudeLocalLauncher(
    session: Session,
    deps: ClaudeLocalLauncherDeps = {}
): Promise<'switch' | 'exit'> {
    const toolResultImages = new ClaudeToolResultImages();

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
            session.localPermissionBridge.onTranscript(message);
            // Esc-interrupted turns fire no Stop hook; Claude Code only
            // writes this marker to the transcript. The scanner can deliver it
            // after the next prompt's hook, so skip markers older than that turn.
            if (session.thinking && isInterruptMarker(message)
                && !(Date.parse(message.timestamp ?? '') < session.localTurnStartedAt)) {
                session.onThinkingChange(false);
            }
            // Preserve the AI-generated title emitted by Claude Code's native
            // interactive CLI. It is metadata, not a visible chat message.
            if (message.type === 'ai-title') {
                applySessionTitleFallback(session.client, message.aiTitle)
                return
            }
            // Claude Code writes its native session title as a summary. Use it as
            // a fallback for older transcript formats.
            if (message.type === 'summary') {
                applySessionTitleFallback(session.client, message.summary)
                return
            }
            // Filter out internal meta messages (e.g. skill injections) and
            // compact summaries to avoid them appearing in the web UI
            if (message.isMeta || message.isCompactSummary) {
                return
            }
            // Filter out invisible system messages (e.g. init, stop_hook_summary)
            // to avoid them showing as raw JSON in the web UI
            if (!isClaudeChatVisibleMessage(message)) {
                return
            }
            stampContextWindow(message, session.localContextModel)
            toolResultImages.send(session.client, message)
        }
    });

    const handleSessionFound = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(handleSessionFound);

    const platform = deps.platform ?? process.platform;
    let processState: 'starting' | 'running' | 'exited' = 'starting';
    const localAbortController = new AbortController();

    const injector = platform === 'win32'
        ? new ConsoleMessageInjector({
            isProcessAlive: () => processState !== 'exited' && session.localPermissionBridge.isNativeProcessObserved(),
            hasPendingPermissions: () => session.localPermissionBridge.hasPendingRequests?.() ?? false,
            waitForPermissionsIdle: (signal) =>
                session.localPermissionBridge.waitForIdle?.(signal ?? localAbortController.signal) ?? Promise.resolve(),
            abortSignal: localAbortController.signal,
            ffi: deps.ffi,
            stashDelayMs: deps.stashDelayMs,
            sleep: deps.sleep,
            platform
        })
        : null;

    const drainQueuedMessagesOnWindows = createLocalMessageDrain({
        queue: session.queue,
        injector: injector!,
        client: session.client,
        signal: localAbortController.signal,
        isExited: () => processState === 'exited',
        isReady: () => {
            if (session.localPermissionBridge.isNativeProcessObserved()) processState = 'running';
            return processState === 'running' && session.localPermissionBridge.isNativeInputReady();
        },
        isPermissionBlocked: () => session.localPermissionBridge.hasPendingRequests(),
    });

    if (injector) session.localPermissionBridge.setInputStateListener(() => {
        if (!localAbortController.signal.aborted) void drainQueuedMessagesOnWindows().then(outcome => {
            if (outcome === 'switch') launcher.control.requestSwitch();
        });
    });

    const launcher = new BaseLocalLauncher({
        label: 'local',
        failureLabel: 'Local Claude process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        onQueuedMessage: injector ? drainQueuedMessagesOnWindows : undefined,
        launch: async (abortSignal) => {
            const forwardAbort = () => {
                if (!localAbortController.signal.aborted) {
                    localAbortController.abort();
                }
            };
            if (abortSignal.aborted) {
                forwardAbort();
            } else {
                abortSignal.addEventListener('abort', forwardAbort, { once: true });
            }
            processState = 'starting';
            session.localPermissionBridge.start(session.sessionId);
            abortSignal.addEventListener('abort', session.localPermissionBridge.stop, { once: true });
            session.localContextModel = resolveClaudeLaunchModel({
                model: session.getModel(),
                cwd: session.path,
                env: session.claudeEnvVars,
                args: session.claudeArgs
            });
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    abort: abortSignal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    model: session.getModel(),
                    permissionMode: session.getPermissionMode(),
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.localHookSettingsPath,
                });
            } finally {
                processState = 'exited';
                abortSignal.removeEventListener('abort', forwardAbort);
                abortSignal.removeEventListener('abort', session.localPermissionBridge.stop);
                session.localPermissionBridge.stop();
            }
        },
        onLaunchSuccess: () => {
            session.consumeOneTimeFlags();
        },
        sendFailureMessage: (message) => {
            session.client.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        },
        abortLogMessage: 'doAbort',
        switchLogMessage: 'doSwitch'
    });
    try {
        return await launcher.run();
    } finally {
        // Cleanup
        session.localPermissionBridge.setInputStateListener(null);
        processState = 'exited';
        if (!localAbortController.signal.aborted) {
            localAbortController.abort();
        }
        session.onThinkingChange(false);
        session.localPermissionBridge.stop();
        session.removeSessionFoundCallback(handleSessionFound);
        await scanner.cleanup();
    }
}
