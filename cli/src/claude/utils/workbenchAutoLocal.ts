/** Called only after ready has flushed the completed turn.
 * Headless launches must never be switched into an interactive local process.
 */
export function shouldAutoReturnLocal(hasTTY: boolean, pending: boolean, queueSize: number, leaving: boolean): boolean {
    return process.env.HAPI_WORKBENCH_AUTO_LOCAL === '1'
        && hasTTY && !pending && queueSize === 0 && !leaving
}
