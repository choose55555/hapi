import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertWorkbenchPermissionChangeAllowed, mergeWorkbenchSettings, workbenchEnabled } from './workbench'
import { filterCatalogAffectingClaudeArgs } from '../sdk/metadataExtractor'

const dirs: string[] = []
afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-workbench-test-'))
    dirs.push(dir)
    const user = join(dir, 'user settings.json')
    const hooks = join(dir, 'hooks.json')
    writeFileSync(user, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' }, env: { KEEP: 'yes' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user' }] }] } }))
    writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'hapi' }] }] } }))
    return { dir, user, hooks }
}
describe('workbench opt-in', () => {
    it.each([undefined, '', '0', 'true', '01', '1'])('enables only literal 1: %s', value => {
        vi.stubEnv('HAPI_WORKBENCH_NO_RUNNER', value)
        expect(workbenchEnabled('HAPI_WORKBENCH_NO_RUNNER')).toBe(value === '1')
    })
    it('disabled settings preserve exact argv and do not read missing files', () => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '0')
        const args = ['--settings', 'missing.json']
        expect(mergeWorkbenchSettings(args, 'missing-hooks.json')).toBeUndefined()
        expect(args).toEqual(['--settings', 'missing.json'])
    })
    it('merges repeated and equals settings without modifying sources, then removes copy', () => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '1')
        const { dir, user, hooks } = fixture()
        const before = readFileSync(user, 'utf8')
        const args = ['--settings', 'user settings.json', '--', '--settings={"extra":42}', '--settings', '{"after":true}', 'prompt']
        const cleanup = mergeWorkbenchSettings(args, hooks, dir)!
        const index = args.indexOf('--settings')
        const path = args[index + 1]
        expect(args).toEqual(['--settings', path, '--', 'prompt'])
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
            permissions: { defaultMode: 'bypassPermissions' }, env: { KEEP: 'yes' }, extra: 42, after: true,
            hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user' }] }, { hooks: [{ type: 'command', command: 'hapi' }] }] }
        })
        expect(readFileSync(user, 'utf8')).toBe(before)
        cleanup()
        cleanup()
        expect(existsSync(path)).toBe(false)
        expect(existsSync(dirname(path))).toBe(false)
    })
    it.each([
        ['{', 'Invalid settings JSON; refusing to launch'],
        ['[]', 'Settings must be a JSON object'],
        ['{"hooks":{"Stop":"bad"}}', 'Settings hook events must contain arrays of objects']
    ])('fails closed for malformed settings %s', (text, reason) => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '1')
        const { user, hooks } = fixture()
        writeFileSync(user, text)
        const args = ['--settings=' + user]
        expect(() => mergeWorkbenchSettings(args, hooks)).toThrow(reason)
        expect(args).toEqual(['--settings=' + user])
    })
    it('rejects missing settings values before changing args', () => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '1')
        expect(() => mergeWorkbenchSettings(['--settings'], undefined)).toThrow('Missing')
    })
    it('writes the merged copy into a fresh child of the user TEMP and removes it on cleanup', () => {
        vi.stubEnv('HAPI_WORKBENCH_MERGE_SETTINGS', '1')
        const args: string[] = []
        const cleanup = mergeWorkbenchSettings(args, undefined)!
        const directory = dirname(args[1])
        try {
            expect(dirname(directory)).toBe(tmpdir())
            expect(directory).toContain('hapi-workbench-settings-')
            expect(JSON.parse(readFileSync(args[1], 'utf8'))).toEqual({})
        } finally {
            cleanup()
        }
        expect(existsSync(directory)).toBe(false)
    })
    it('retains remote prompt/MCP flags in exact repeated order only when opted in', () => {
        const args = ['--system-prompt-file', 'a.txt', '--mcp-config=a.json', '--mcp-config', 'b.json', '--system-prompt-file=b.txt', '--settings', 's.json']
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', '0')
        expect(filterCatalogAffectingClaudeArgs(args)).toEqual(['--settings', 's.json'])
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', '1')
        expect(filterCatalogAffectingClaudeArgs(args)).toEqual(args)
        expect(() => assertWorkbenchPermissionChangeAllowed()).toThrow('手机端不能切换')
        vi.stubEnv('HAPI_WORKBENCH_PRESERVE_REMOTE', 'true')
        expect(() => assertWorkbenchPermissionChangeAllowed()).not.toThrow()
    })
})
