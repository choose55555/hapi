export interface HubInstance {
    stop(): Promise<void>
}

export interface StartHubOptions {
    args?: string[]
}

export function startHub(options?: StartHubOptions): Promise<HubInstance>

export function revokeWorkbenchCredential(deps?: {
    rotateJwtSecret?: (dataDir: string) => Promise<void>
}): Promise<void>

export function printWorkbenchLoginQr(): Promise<void>
