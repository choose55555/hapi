import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { isTranscriptEchoContent } from './transcriptEcho.ts';

registerHooks({
    resolve(specifier, context, next) {
        const stub = (source) => ({
            url: 'data:text/javascript,' + encodeURIComponent(source),
            shortCircuit: true
        });
        if (specifier === '@hapi/protocol/messages') {
            return stub('export function unwrapRoleWrappedRecordEnvelope(value){ if (value && typeof value === "object" && typeof value.role === "string" && "content" in value) return value; return null }');
        }
        if (specifier === '@hapi/protocol') {
            return stub('export function safeStringify(value){ return typeof value === "string" ? value : JSON.stringify(value) }');
        }
        if (specifier === '@/chat/normalizeAgent') {
            return stub('export function isCodexContent(){ return false } export function isSkippableAgentContent(){ return false } export function normalizeAgentRecord(){ return null }');
        }
        if (specifier === '@/chat/normalizeUser') {
            return stub('export function normalizeUserRecord(){ return null }');
        }
        return next(specifier, context);
    }
});

test('phone echo row is hidden and a computer-typed row is kept', () => {
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
    const webapp = {
        role: 'user',
        content: { type: 'text', text: '你好' },
        meta: { sentFrom: 'webapp', deliveryMode: 'queue' }
    };
    assert.equal(isTranscriptEchoContent(echo), true);
    assert.equal(isTranscriptEchoContent(typed), false);
    assert.equal(isTranscriptEchoContent(webapp), false);
    assert.equal(isTranscriptEchoContent({ message: echo }), true);
    assert.equal(isTranscriptEchoContent({ data: { message: echo } }), true);
    assert.equal(isTranscriptEchoContent({ payload: { message: typed } }), false);
    assert.equal(isTranscriptEchoContent({ role: 'user', content: { type: 'text', text: '你好' }, meta: { isTranscriptEcho: false } }), false);
    assert.equal(isTranscriptEchoContent(null), false);
});

function decrypted(content) {
    return {
        id: 'm1',
        localId: 'l1',
        createdAt: 1,
        content,
        status: 'ok'
    };
}

test('normalizeDecryptedMessage drops the echo and keeps a computer-typed row', async () => {
    const { normalizeDecryptedMessage } = await import('./normalize.ts');
    const echo = decrypted({
        role: 'user',
        content: { type: 'text', text: '你好' },
        meta: { sentFrom: 'cli', isTranscriptEcho: true }
    });
    const typed = decrypted({
        role: 'user',
        content: { type: 'text', text: '你好' },
        meta: { sentFrom: 'cli' }
    });
    const wrapped = decrypted({
        message: {
            role: 'user',
            content: { type: 'text', text: '你好' },
            meta: { sentFrom: 'cli', isTranscriptEcho: true }
        }
    });
    assert.equal(normalizeDecryptedMessage(echo), null);
    assert.equal(normalizeDecryptedMessage(wrapped), null);
    const kept = normalizeDecryptedMessage(typed);
    assert.notEqual(kept, null);
    assert.equal(kept.role, 'user');
});
