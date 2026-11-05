import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../../../.github/workflows/release.yml', import.meta.url), 'utf8')

// Read the actual two workflow patterns, rather than maintaining a third copy.
const bashPattern = workflow.match(/\[\[ "\$REQUESTED_TAG" =~ (.+) \]\]/)?.[1]
const windowsPattern = workflow.match(/\$env:EXPECTED_TAG -cnotmatch '([^']+)'/)?.[1]

describe('workbench release tag identity', () => {
    it.each(['workbench-v0.34.1', 'workbench-v0.34.1-1', 'workbench-v0.34.1-12'])('compares only the upstream version for %s', tag => {
        expect(bashPattern).toBeDefined()
        expect(windowsPattern).toBeDefined()
        for (const pattern of [bashPattern!, windowsPattern!]) {
            // These patterns use the regex subset shared by Bash ERE, .NET and JS.
            const match = new RegExp(pattern).exec(tag)
            expect(match?.[1]).toBe('0.34.1')
        }
        expect(workflow).toContain('TAG_VERSION="${BASH_REMATCH[1]}"')
        expect(workflow).toContain('test "$TAG_VERSION" = "$VERSION"')
        expect(workflow).toContain('$version = $Matches[1]')
        expect(workflow).toContain('$stdout.Result.Trim() -ne "hapi version: $version"')
        // Keep the full tag for publication; only version comparison strips N.
        expect(workflow).toContain('echo "tag=$REQUESTED_TAG" >> "$GITHUB_OUTPUT"')
    })

    it.each(['v0.34.1', 'workbench-v0.34', 'workbench-v0.34.1-', 'workbench-v0.34.1-0',
        'workbench-v0.34.1-01', 'workbench-v0.34.1-rc', 'workbench-v0.34.1-1-extra', 'workbench-v0.34.1.2'])('rejects invalid release tag %s', tag => {
        expect(bashPattern).toBeDefined()
        expect(windowsPattern).toBeDefined()
        for (const pattern of [bashPattern!, windowsPattern!]) {
            expect(new RegExp(pattern).test(tag)).toBe(false)
        }
    })
})
