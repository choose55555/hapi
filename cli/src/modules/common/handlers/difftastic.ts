import { resolve } from 'node:path'
import { workbenchNoShell } from '../workbenchShell'
import { resolveRealPathWithinWorkingDirectory } from '../pathSecurity'
import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { run as runDifftastic } from '@/modules/difftastic/index'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface DifftasticRequest {
    args: string[]
    cwd?: string
}

interface DifftasticResponse {
    success: boolean
    exitCode?: number
    stdout?: string
    stderr?: string
    error?: string
}

export function registerDifftasticHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>(RPC_METHODS.Difftastic, async (data) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd)

        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory)
            if (!validation.valid) {
                return rpcError(workbenchNoShell()
                    ? '差异比较目录必须在当前会话工作目录内。'
                    : validation.error ?? 'Invalid working directory')
            }
        }

        try {
            let args = data.args
            let cwd = data.cwd
            if (workbenchNoShell()) {
                const safeCwd = await resolveRealPathWithinWorkingDirectory(data.cwd ?? workingDirectory, workingDirectory)
                if (!safeCwd) return rpcError('差异比较目录必须在当前会话工作目录内。')
                // Only two file operands are accepted in restricted mode: no
                // unknown option can smuggle another path or change path parsing.
                const paths = data.args[0] === '--' ? data.args.slice(1) : data.args
                if (paths.length !== 2 || paths.some(path => !path || path.startsWith('-'))) {
                    return rpcError('工作台差异比较只接受当前会话目录内的两个文件路径。')
                }
                const safePaths = await Promise.all(paths.map(path =>
                    resolveRealPathWithinWorkingDirectory(resolve(safeCwd, path), workingDirectory)))
                if (safePaths.some(path => !path)) return rpcError('差异比较文件越出了当前会话工作目录，已拒绝。')
                args = ['--', ...(safePaths as string[])]
                cwd = safeCwd
            }
            const result = await runDifftastic(args, { cwd })
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            }
        } catch (error) {
            logger.debug('Failed to run difftastic:', error)
            return rpcError(getErrorMessage(error, 'Failed to run difftastic'))
        }
    })
}
