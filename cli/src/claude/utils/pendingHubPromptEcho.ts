export function normalizePendingEchoText(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** Compare a hook prompt with markers recorded before a phone inject. Does not consume them. */
export function isPendingHubPromptEcho(entries: readonly { text: string }[], text: string): boolean {
    const normalized = normalizePendingEchoText(text);
    if (!normalized) return false;
    return entries.some((entry) => normalizePendingEchoText(entry.text) === normalized);
}
