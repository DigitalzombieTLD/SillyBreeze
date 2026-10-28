import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    extractQuotedAndParenthetical,
    parseInstructionParagraphs,
} from '../extension/logic.js';
import {
    createSerialQueue,
    createSpeechForm,
    deleteReferenceWav,
    getAuthenticatedUserDirectories,
    getReferencePath,
    pcmResponseToWav,
    storeReferenceWav,
    synthesizeSpeech,
    validateBreezeBaseUrl,
    validateReferenceWav,
} from '../plugin/core.js';

const REFERENCE_ID = '123e4567-e89b-42d3-a456-426614174000';

function makeReferenceWav() {
    const wav = Buffer.alloc(46);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(38, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24_000, 24);
    wav.writeUInt32LE(48_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(2, 40);
    wav.writeUInt16LE(0x1234, 44);
    return wav;
}

function makePcmResponse(chunks = [[0x34], [0x12, 0x78, 0x56]]) {
    const body = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(Uint8Array.from(chunk));
            }
            controller.close();
        },
    });
    return new Response(body, {
        headers: {
            'Content-Type': 'audio/pcm',
            'X-Sample-Rate': '24000',
            'X-Sample-Format': 's16le',
        },
    });
}

test('instruction parsing is untouched when disabled', () => {
    const original = '  First paragraph\n\n<instructions="pirate">Second paragraph  ';
    assert.deepEqual(parseInstructionParagraphs(original, false), [{ text: original }]);
});

test('instruction parsing splits paragraphs and strips instruction tags from speech text', () => {
    assert.deepEqual(parseInstructionParagraphs(
        ' <instructions="Speak like a pirate."> Ahoy!\n\nNo instruction <instructions="leave this">',
        true,
    ), [
        { text: 'Ahoy!', instruction: 'Speak like a pirate.' },
        { text: 'No instruction', instruction: 'leave this' },
    ]);
});

test('paragraph markers survive SillyTavern whitespace normalization', () => {
    const marker = '\uE000SILLYBREEZE_test\uE001';
    const encoded = 'First paragraph\n\nSecond paragraph'.split(/\n[ \t]*\n+/).join(marker);
    const normalized = encoded.replace(/\s+/g, ' ').trim();
    assert.deepEqual(normalized.split(marker), ['First paragraph', 'Second paragraph']);
});

test('quoted plus parenthetical filter preserves matching spans in paragraph order', () => {
    assert.equal(
        extractQuotedAndParenthetical('He said "hello" (sighs), then left.\n\nNo speech here. “Goodbye.”'),
        '"hello" (sighs)\n\n“Goodbye.”',
    );
});

test('quoted filter retains a leading instruction tag for later parsing', () => {
    assert.equal(
        extractQuotedAndParenthetical('<instructions="gentle">Narration "Hello" (sighs)'),
        '<instructions="gentle"> "Hello" (sighs)',
    );
});

test('Breeze URLs allow only localhost and private numeric addresses', () => {
    assert.equal(validateBreezeBaseUrl('http://127.0.0.1:7860'), 'http://127.0.0.1:7860');
    assert.equal(validateBreezeBaseUrl('http://192.168.1.20:7860/'), 'http://192.168.1.20:7860');
    assert.equal(validateBreezeBaseUrl('http://[fd00::1]:7860'), 'http://[fd00::1]:7860');
    assert.throws(() => validateBreezeBaseUrl('https://example.com'), /localhost or a private LAN IP/);
    assert.throws(() => validateBreezeBaseUrl('http://192.168.1.2@127.0.0.1'), /credentials/);
    assert.throws(() => validateBreezeBaseUrl('file:///etc/passwd'), /must use HTTP or HTTPS/);
    assert.throws(() => validateBreezeBaseUrl('http://127.0.0.1/proxy'), /must not include/);
    assert.throws(() => validateBreezeBaseUrl('http://169.254.169.254'), /localhost or a private LAN IP/);
});

test('reference WAV validation checks extension, container, chunks, and size', () => {
    const wav = makeReferenceWav();
    assert.equal(validateReferenceWav('voice.WAV', wav), wav);
    assert.throws(() => validateReferenceWav('voice.mp3', wav), /\.wav extension/);
    assert.throws(() => validateReferenceWav('voice.wav', Buffer.from('not a wave file')), /between 44 bytes/);

    const malformed = Buffer.from(wav);
    malformed.writeUInt32LE(0xffffffff, 40);
    assert.throws(() => validateReferenceWav('voice.wav', malformed), /invalid chunk length/);
});

test('reference paths require an authenticated user and a UUID, and are user scoped', () => {
    assert.throws(() => getAuthenticatedUserDirectories({}), /Authenticated user storage/);
    const userA = getReferencePath({ files: '/data/alice/user/files' }, REFERENCE_ID);
    const userB = getReferencePath({ files: '/data/bob/user/files' }, REFERENCE_ID);
    assert.equal(userA.filePath, `/data/alice/user/files/sillybreeze/${REFERENCE_ID}.wav`);
    assert.notEqual(userA.filePath, userB.filePath);
    assert.throws(() => getReferencePath({ files: '/data/alice/user/files' }, '../outside'), /Invalid reference audio ID/);
    assert.throws(() => getReferencePath({ files: 'relative/files' }, REFERENCE_ID), /Authenticated user storage/);
});

test('reference upload stores WAV bytes under the authenticated user with an opaque UUID', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybreeze-test-'));
    try {
        const files = path.join(temporaryDirectory, 'user', 'files');
        const reference = await storeReferenceWav({ files }, 'supplied-name.wav', makeReferenceWav());
        assert.match(reference.id, /^[0-9a-f-]{36}$/i);
        assert.equal(reference.name, `${reference.id}.wav`);
        assert.deepEqual(
            await fs.readFile(path.join(files, 'sillybreeze', `${reference.id}.wav`)),
            makeReferenceWav(),
        );
        await deleteReferenceWav({ files }, reference.id);
        await assert.rejects(fs.access(path.join(files, 'sillybreeze', `${reference.id}.wav`)), { code: 'ENOENT' });
        await assert.rejects(storeReferenceWav({}, 'voice.wav', makeReferenceWav()), /Authenticated user storage/);
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});

test('PCM chunks are wrapped in a valid mono 24 kHz WAV container', async () => {
    const wav = await pcmResponseToWav(makePcmResponse());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 24_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 4);
    assert.deepEqual(wav.subarray(44), Buffer.from([0x34, 0x12, 0x78, 0x56]));
});

test('unsupported PCM headers and odd sample lengths fail clearly', async () => {
    const unsupported = new Response(new Uint8Array([1, 2]), {
        headers: { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '16000', 'X-Sample-Format': 's16le' },
    });
    await assert.rejects(pcmResponseToWav(unsupported), /unsupported audio format/);
    await assert.rejects(pcmResponseToWav(makePcmResponse([[1]])), /invalid PCM stream length/);
});

test('speech multipart contains only supported Breeze fields and optional reference audio', async () => {
    const referenceWav = makeReferenceWav();
    const options = { text: 'Hello', instruction: 'Speak gently', cfgScale: 1.2, seed: 42, refText: 'Exact words' };
    const form = createSpeechForm(options, referenceWav);
    assert.equal(form.get('text'), 'Hello');
    assert.equal(form.get('instruction'), 'Speak gently');
    assert.equal(form.get('cfg_scale'), '1.2');
    assert.equal(form.get('seed'), '42');
    assert.equal(form.get('ref_text'), 'Exact words');
    assert.equal(form.get('ref_audio').name, 'reference.wav');
    assert.deepEqual([...form.keys()], ['text', 'instruction', 'cfg_scale', 'seed', 'ref_audio', 'ref_text']);
    assert.deepEqual(Buffer.from(await form.get('ref_audio').arrayBuffer()), referenceWav);

    const noInstruction = createSpeechForm({ text: 'Hello', cfgScale: 1, seed: 42 }, null);
    assert.equal(noInstruction.has('instruction'), false);
    assert.equal(noInstruction.has('ref_audio'), false);
    assert.equal(noInstruction.has('ref_text'), false);

    const plainWithCfg = createSpeechForm({ text: 'Hello', cfgScale: 4, seed: 42, refText: 'x' }, referenceWav);
    assert.equal(plainWithCfg.get('cfg_scale'), '1');
});

test('speech proxy sends one supported request and rejects redirects', async () => {
    const calls = [];
    const wav = await synthesizeSpeech({
        endpoint: 'http://192.168.1.20:7860',
        text: 'Hello',
        cfg_scale: 1,
        seed: 42,
    }, null, async (url, options) => {
        calls.push({ url, options });
        return makePcmResponse();
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://192.168.1.20:7860/v1/audio/speech');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(calls[0].options.body.get('text'), 'Hello');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');

    await assert.rejects(synthesizeSpeech({
        endpoint: 'http://192.168.1.20:7860',
        text: 'Hello',
    }, null, async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })), /redirected/);
});

test('remote errors surface status and detail', async () => {
    await assert.rejects(synthesizeSpeech({
        endpoint: 'http://localhost:7860',
        text: 'Hello',
    }, null, async () => new Response('invalid reference', { status: 422 })), /HTTP 422: invalid reference/);
    await assert.rejects(synthesizeSpeech({
        endpoint: 'http://localhost:7860',
        text: 'Hello',
    }, null, async () => {
        throw new Error('connection refused');
    }), /Could not connect to Breeze: connection refused/);
});

test('single-concurrency queue serializes tasks and continues after failures', async () => {
    const enqueue = createSerialQueue();
    const events = [];
    let active = 0;
    let maximumActive = 0;
    const run = name => enqueue(async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        events.push(`${name}:start`);
        await new Promise(resolve => setTimeout(resolve, 5));
        events.push(`${name}:end`);
        active--;
        if (name === 'fail') {
            throw new Error('failed');
        }
    });

    const results = await Promise.allSettled([run('one'), run('fail'), run('three')]);
    assert.equal(maximumActive, 1);
    assert.deepEqual(events, ['one:start', 'one:end', 'fail:start', 'fail:end', 'three:start', 'three:end']);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('instruction tags are stripped from speech text in every format', () => {
    assert.deepEqual(parseInstructionParagraphs('[instruction="whisper"] Hi (sighs) there [instruction="x"]', true, 'square'), [
        { text: 'Hi (sighs) there', instruction: 'whisper x' },
    ]);
    assert.deepEqual(parseInstructionParagraphs('(instruction="calm") Hello (sighs) friend', true, 'round'), [
        { text: 'Hello (sighs) friend', instruction: 'calm' },
    ]);
    assert.deepEqual(parseInstructionParagraphs('Hello <instruction="loud"> there', true, 'angle'), [
        { text: 'Hello there', instruction: 'loud' },
    ]);
    assert.deepEqual(parseInstructionParagraphs('<instruction="loud"> [instruction="a"] Hi', true, 'square'), [
        { text: '<instruction="loud"> Hi', instruction: 'a' },
    ]);
});

test('quoted filter keeps a leading instruction tag in the selected format', () => {
    assert.equal(extractQuotedAndParenthetical('[instruction="soft"]Narration "Hello" (sighs)', 'square'), '[instruction="soft"] "Hello" (sighs)');
});

test('instruction-only paragraph applies to the next paragraph when merging is enabled', () => {
    const input = '<instruction="calm">\n\nHello there.\n\nPlain.';
    assert.deepEqual(parseInstructionParagraphs(input, true, 'angle', true), [
        { text: 'Hello there.', instruction: 'calm' },
        { text: 'Plain.' },
    ]);
    assert.deepEqual(parseInstructionParagraphs(input, true, 'angle', false), [
        { text: 'Hello there.' },
        { text: 'Plain.' },
    ]);
    assert.equal(extractQuotedAndParenthetical('<instruction="calm">\n\n"Hi"', 'angle', true), '<instruction="calm">\n\n"Hi"');
});
