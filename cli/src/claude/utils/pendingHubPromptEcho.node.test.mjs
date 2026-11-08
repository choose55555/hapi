import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPendingHubPromptEcho, normalizePendingEchoText } from './pendingHubPromptEcho.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

test('phone inject still pending is recognized without consuming it', () => {
    const entries = [{ text: 'hello\nfrom phone' }];
    assert.equal(isPendingHubPromptEcho(entries, 'hello\r\nfrom phone'), true);
    assert.equal(isPendingHubPromptEcho(entries, '  hello\nfrom phone  '), true);
    assert.equal(entries.length, 1);
    assert.equal(isPendingHubPromptEcho(entries, 'hello from phone'), false);
    assert.equal(isPendingHubPromptEcho(entries, ''), false);
    assert.equal(isPendingHubPromptEcho([], 'hello\nfrom phone'), false);
    assert.equal(normalizePendingEchoText(' a\r\nb '), 'a\nb');
});

test('api session peeks the same list and does not consume it', () => {
    const source = fs.readFileSync(path.resolve(here, '../../api/apiSession.ts'), 'utf8');
    assert.match(source, /hasPendingHubPromptEcho\(text: string\): boolean \{\s*return isPendingHubPromptEcho\(this\.pendingHubPromptEchoes, text\)/);
    assert.match(source, /private consumePendingHubPromptEcho\(text: string\): boolean/);
});
