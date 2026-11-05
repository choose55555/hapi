import { describe, expect, it } from 'vitest'
import { claudeHookCommand } from './claudeHookCommand'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

describe('Claude hook command quoting', () => {
    it('uses quoted forward-slash paths for Windows bash and cmd', () => {
        expect(claudeHookCommand(['C:\\Users\\lenovo\\hapi.exe', 'hook-forwarder', '--port', '53958'], 'win32'))
            .toBe('"C:/Users/lenovo/hapi.exe" "hook-forwarder" "--port" "53958"')
        expect(claudeHookCommand(['C:\\Program Files\\中文\\hapi.exe', 'C:\\工作\\index.ts'], 'win32'))
            .toBe('"C:/Program Files/中文/hapi.exe" "C:/工作/index.ts"')
    })
    it.each(['%', '!', '$', '`', '"', '\n', '\r'])('rejects cross-shell ambiguous input %j', char => {
        expect(() => claudeHookCommand(['C:/hapi.exe', 'token' + char], 'win32')).toThrow()
    })
    it('preserves POSIX shell joining', () => {
        expect(claudeHookCommand(['/a b/hapi', 'hook-forwarder'], 'linux')).toBe('"/a b/hapi" hook-forwarder')
    })
    it.skipIf(process.platform !== 'win32')('round-trips argv through actual Windows bash and cmd without starting HAPI', () => {
        const bash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']
            .find(path => existsSync(path))
        if (!bash) throw new Error('Windows Git bash fixture unavailable')
        const argument = 'plain-中文-argument'
        const command = claudeHookCommand([
            process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(-1)))', argument
        ], 'win32')
        const bashResult = spawnSync(bash, ['-c', command], { encoding: 'utf8', timeout: 10000 })
        expect(bashResult.error).toBeUndefined()
        expect(bashResult.status).toBe(0)
        expect(JSON.parse(bashResult.stdout)).toEqual([argument])
        const cmdResult = spawnSync(command, { shell: process.env.ComSpec || 'cmd.exe', encoding: 'utf8', timeout: 10000 })
        expect(cmdResult.error).toBeUndefined()
        expect(cmdResult.status).toBe(0)
        expect(JSON.parse(cmdResult.stdout)).toEqual([argument])
    })
})

