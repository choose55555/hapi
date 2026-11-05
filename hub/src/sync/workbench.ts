import { HTTPException } from 'hono/http-exception'
import type { MiddlewareHandler } from 'hono'
import type { WebAppEnv } from '../web/middleware/auth'

export const WORKBENCH_NO_SPAWN_MESSAGE = '工作台禁止手机新建会话，请在电脑工作台打开窗口后接管。'
export const PERMISSION_LOCK_MESSAGE = '工作台权限模式由电脑启动参数决定，手机端不能切换。'

export function assertWorkbenchPermissionChangeAllowed(): void {
    if (process.env.HAPI_WORKBENCH_PRESERVE_REMOTE === '1') {
        throw new Error(PERMISSION_LOCK_MESSAGE)
    }
}

export function assertWorkbenchSpawnAllowed(): void {
    if (process.env.HAPI_WORKBENCH_NO_SPAWN === '1') {
        throw new HTTPException(403, {
            message: WORKBENCH_NO_SPAWN_MESSAGE,
            res: new Response(JSON.stringify({ error: WORKBENCH_NO_SPAWN_MESSAGE, code: 'workbench_no_spawn' }), {
                status: 403,
                headers: { 'content-type': 'application/json' }
            })
        })
    }
}

/** Registration from running local CLIs and ordinary messages stay available. */
export const workbenchSpawnMiddleware: MiddlewareHandler<WebAppEnv> = async (c, next) => {
    if (c.req.method === 'POST' && (
        /\/machines\/[^/]+\/(?:spawn|restart-runner)\/?$/.test(c.req.path)
        || /\/sessions\/[^/]+\/(?:fork|resume|reopen|clear|migrate-to-acp|codex\/plan\/implement)\/?$/.test(c.req.path)
    )) assertWorkbenchSpawnAllowed()
    await next()
}
