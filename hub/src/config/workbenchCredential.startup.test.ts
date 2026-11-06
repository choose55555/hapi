import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('TTL and CLI_API_TOKEN together fail before startup persists credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-credential-conflict-'))
    try {
        const configurationPath = join(import.meta.dir, '..', 'configuration.ts')
        const child = Bun.spawn([process.execPath, '--eval', `import { createConfiguration } from ${JSON.stringify(configurationPath)}; await createConfiguration()`], {
            env: { ...process.env, HAPI_HOME: directory, HAPI_WORKBENCH_CREDENTIAL_TTL_DAYS: '30', CLI_API_TOKEN: 'test-only-env-value' },
            stdout: 'pipe', stderr: 'pipe'
        })
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
        ])
        expect(exitCode).not.toBe(0)
        expect(stderr).toContain('CLI_API_TOKEN cannot be used')
        expect(stdout + stderr).not.toContain('test-only-env-value')
        expect(await Bun.file(join(directory, 'settings.json')).exists()).toBe(false)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
