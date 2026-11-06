export function bindCredentialDisconnect(
    credential: { onRotate(listener: () => void): () => void } | null,
    close: () => void
): void {
    credential?.onRotate(close)
}

export function disconnectCredentialClients(
    sockets: Iterable<{ close(code: number, reason: string): void }>,
    events: { disconnectAll(): void } | null
): void {
    for (const socket of sockets) socket.close(1008, 'Credential changed')
    events?.disconnectAll()
}
