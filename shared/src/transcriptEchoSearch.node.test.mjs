import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { test } from 'node:test';

// Node needs the stubs below to load messages.ts without the package's dependencies.
// Bun (CI `bun test` picks this file up too) resolves the real dependencies and has no
// registerHooks, so the hooks are only installed when the runtime provides them.
if (typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks({
    resolve(specifier, context, next) {
        const stub = (source) => ({
            url: 'data:text/javascript,' + encodeURIComponent(source),
            shortCircuit: true
        });
        const parent = context.parentURL ?? '';
        if (parent.endsWith('/messages.ts') && specifier === './utils') {
            return stub('export function isObject(value){ return Boolean(value) && typeof value === "object" }');
        }
        if (parent.endsWith('/messages.ts') && specifier === './modes') {
            return stub('export const AGENT_MESSAGE_PAYLOAD_TYPE = "codex"');
        }
        if (specifier === 'mdast-util-from-markdown') {
            return stub('export function fromMarkdown(){ throw new Error("stub") }');
        }
        if (specifier === 'mdast-util-gfm') {
            return stub('export function gfmFromMarkdown(){ return function () {} }');
        }
        if (specifier === 'micromark-extension-gfm') {
            return stub('export function gfm(){ return {} }');
        }
        return next(specifier, context);
    }
});

test('extractSearchableMessageText skips a transcript echo and keeps a typed row', async () => {
    const { extractSearchableMessageText } = await import('./messages.ts');
    const echo = {
        role: 'user',
        content: { type: 'text', text: '你好' },
        meta: { sentFrom: 'cli', isTranscriptEcho: true }
    };
    const typed = {
        role: 'user',
        content: { type: 'text', text: '你好' },
        meta: { sentFrom: 'cli' }
    };
    const flaggedFalse = {
        role: 'user',
        content: { type: 'text', text: '电脑上打的' },
        meta: { isTranscriptEcho: false }
    };
    assert.equal(extractSearchableMessageText(echo), null);
    assert.equal(extractSearchableMessageText({ message: echo }), null);
    assert.deepEqual(extractSearchableMessageText(typed), { role: 'user', text: '你好' });
    assert.deepEqual(extractSearchableMessageText(flaggedFalse), { role: 'user', text: '电脑上打的' });
    assert.deepEqual(extractSearchableMessageText({
        role: 'agent',
        content: { type: 'text', text: '可见回答' }
    }), { role: 'assistant', text: '可见回答' });
});
