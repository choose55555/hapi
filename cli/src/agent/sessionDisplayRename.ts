import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';

type SessionDisplayRenameClient = Pick<ApiSessionClient, 'updateMetadata'>;

/** Session name copied from the selected Windows Terminal tab. Not titleLocked. */
export const TERMINAL_TAB_NAME_SOURCE = 'terminal-tab';

/**
 * Explicit agent/operator rename: set metadata.name (same field as web
 * renameSession / PATCH /sessions/:id). Distinct from native/generated
 * summaries, which must not overwrite an intentional name.
 */
export function normalizeSessionDisplayTitle(title: unknown): string | null {
    if (typeof title !== 'string') {
        return null;
    }
    const normalized = title.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * change_title keeps a tab name. Success, so the model does not retry.
 * unchanged tells the tool text not to claim the title was replaced.
 */
export function changeTitleResultIfTerminalTab(
    metadata: { nameSource?: unknown } | null | undefined
): { success: true; unchanged: true } | null {
    if (metadata?.nameSource === TERMINAL_TAB_NAME_SOURCE) {
        return { success: true, unchanged: true };
    }
    return null;
}

export function changeTitleToolText(
    response: { success: boolean; error?: string; unchanged?: boolean },
    displayTitle: string
): { text: string; isError: boolean } {
    if (response.success && response.unchanged) {
        return { text: 'Session name stays the Windows Terminal tab name.', isError: false };
    }
    if (response.success) {
        return { text: `Successfully changed chat title to: "${displayTitle}"`, isError: false };
    }
    return { text: `Failed to change chat title: ${response.error || 'Unknown error'}`, isError: true };
}

export function applySessionDisplayRename(
    client: SessionDisplayRenameClient,
    title: unknown
): boolean {
    const normalized = normalizeSessionDisplayTitle(title);
    if (!normalized) {
        return false;
    }

    client.updateMetadata((metadata: Metadata) => {
        if (metadata.titleLocked) return metadata;
        if ((metadata as { nameSource?: unknown }).nameSource === TERMINAL_TAB_NAME_SOURCE) return metadata;
        if (metadata.name?.trim() === normalized) {
            return metadata;
        }
        return {
            ...metadata,
            name: normalized
        };
    });
    return true;
}
