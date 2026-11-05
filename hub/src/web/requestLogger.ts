import { createMiddleware } from 'hono/factory'

/** Access logs deliberately omit ALL query data, independent of workbench switches.
 * Read c.req.path rather than rewriting the request: SSE auth still receives its token.
 */
export function requestLogger(print: (line: string) => void = console.log) {
    return createMiddleware(async (c, next) => {
        const started = Date.now()
        const method = c.req.method
        const path = c.req.path
        print(`<-- ${method} ${path}`)
        await next()
        print(`--> ${method} ${path} ${c.res.status} ${Date.now() - started}ms`)
    })
}
