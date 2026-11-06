import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('shell-only build precache', () => {
    it('uses an explicit shell allowlist rather than the full build glob', () => {
        const config = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8')
        expect(config).toContain("globPatterns: ['index.html', 'assets/index-*.js', 'assets/index-*.css', '*.ico', '*.png', 'icon.svg', 'mask-icon.svg', 'manifest.webmanifest']")
        expect(config).not.toContain("globPatterns: ['**/*.")
        // Keep prompt callbacks available for the existing banner/manual reload fallback.
        expect(config).toContain("registerType: 'prompt'")
    })
})
