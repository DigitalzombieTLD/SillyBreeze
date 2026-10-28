import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
export const MAX_PCM_BYTES = 64 * 1024 * 1024;
export const REFERENCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BreezeUpstreamError extends Error {}

function isPrivateIPv4(address) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
        return false;
    }

    return octets[0] === 10
        || octets[0] === 127
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168);
}

function isPrivateIPv6(address) {
    const normalized = address.toLowerCase();
    if (normalized === '::1') {
        return true;
    }
    if (normalized.includes('.')) {
        return false;
    }
    const firstHextet = normalized.split(':').find(Boolean);
    return Boolean(firstHextet && /^[fc][0-9a-f]{0,3}$/.test(firstHextet));
}

export function validateBreezeBaseUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Breeze URL must be a valid HTTP(S) URL.');
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Breeze URL must use HTTP or HTTPS.');
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Breeze URL must not include credentials, a path, query, or fragment.');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const ipVersion = net.isIP(hostname);
    const allowed = hostname === 'localhost'
        || (ipVersion === 4 && isPrivateIPv4(hostname))
        || (ipVersion === 6 && isPrivateIPv6(hostname));
    if (!allowed) {
        throw new Error('Breeze URL must use localhost or a private LAN IP address.');
    }

    return url.origin;
}

export function validateReferenceWav(fileName, data) {
    if (typeof fileName !== 'string' || path.extname(fileName).toLowerCase() !== '.wav') {
        throw new Error('Reference audio must have a .wav extension.');
    }
    if (!Buffer.isBuffer(data) || data.length < 44 || data.length > MAX_REFERENCE_BYTES) {
        throw new Error(`Reference WAV must be between 44 bytes and ${MAX_REFERENCE_BYTES} bytes.`);
    }
    if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Reference audio is not a RIFF/WAVE file.');
    }

    const declaredLength = data.readUInt32LE(4) + 8;
    if (declaredLength > data.length || declaredLength < 44) {
        throw new Error('Reference WAV has an invalid RIFF length.');
    }

    let offset = 12;
    let hasFormat = false;
    let hasAudioData = false;
    while (offset + 8 <= declaredLength) {
        const chunkName = data.toString('ascii', offset, offset + 4);
        const chunkLength = data.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + chunkLength;
        const paddedEnd = chunkEnd + (chunkLength % 2);
        if (paddedEnd > declaredLength) {
            throw new Error('Reference WAV contains an invalid chunk length.');
        }
        if (chunkName === 'fmt ' && chunkLength >= 16) {
            hasFormat = true;
        } else if (chunkName === 'data' && chunkLength > 0) {
            hasAudioData = true;
        }
        offset = paddedEnd;
    }

    if (offset !== declaredLength) {
        throw new Error('Reference WAV contains an incomplete chunk header.');
    }

    if (!hasFormat || !hasAudioData) {
        throw new Error('Reference WAV must include valid format and audio data chunks.');
    }
    return data;
}

export function getReferencePath(userDirectories, id) {
    if (!REFERENCE_ID_PATTERN.test(String(id))) {
        throw new Error('Invalid reference audio ID.');
    }
    if (!userDirectories || typeof userDirectories.files !== 'string' || !path.isAbsolute(userDirectories.files)) {
        throw new Error('Authenticated user storage is unavailable.');
    }

    const directory = path.resolve(userDirectories.files, 'sillybreeze');
    const filePath = path.resolve(directory, `${id}.wav`);
    if (path.dirname(filePath) !== directory) {
        throw new Error('Invalid reference audio ID.');
    }
    return { directory, filePath };
}

export async function storeReferenceWav(userDirectories, fileName, data) {
    validateReferenceWav(fileName, data);
    const id = randomUUID();
    const { directory, filePath } = getReferencePath(userDirectories, id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, data, { flag: 'wx', mode: 0o600 });
    return { id, name: `${id}.wav` };
}

export async function deleteReferenceWav(userDirectories, id) {
    const { filePath } = getReferencePath(userDirectories, id);
    await fs.rm(filePath, { force: true });
}

export function getAuthenticatedUserDirectories(request) {
    const directories = request?.user?.directories;
    if (!directories || typeof directories.files !== 'string' || !directories.files) {
        throw new Error('Authenticated user storage is unavailable.');
    }
    // SillyTavern's data root may be relative (default './data').
    return { ...directories, files: path.resolve(directories.files) };
}

export function validateSpeechOptions(input) {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100_000) {
        throw new Error('Speech text must be a non-empty string of at most 100,000 characters.');
    }

    const cfgScale = input.cfg_scale === undefined ? 1 : Number(input.cfg_scale);
    if (!Number.isFinite(cfgScale) || cfgScale < 0 || cfgScale > 100) {
        throw new Error('CFG scale must be a number between 0 and 100.');
    }
    const seed = input.seed === undefined ? 42 : Number(input.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw new Error('Seed must be an unsigned 32-bit integer.');
    }
    if (input.instruction !== undefined && (typeof input.instruction !== 'string' || input.instruction.length > 2_000)) {
        throw new Error('Instruction must be a string of at most 2,000 characters.');
    }
    if (input.ref_text !== undefined && (typeof input.ref_text !== 'string' || input.ref_text.length > 50_000)) {
        throw new Error('Reference transcript must be a string of at most 50,000 characters.');
    }

    return { text: input.text, instruction: input.instruction, cfgScale, seed, refText: input.ref_text };
}

export function createSpeechForm(options, referenceAudio) {
    const form = new FormData();
    form.set('text', options.text);
    if (options.instruction) {
        form.set('instruction', options.instruction);
    }
    form.set('cfg_scale', String(options.cfgScale));
    form.set('seed', String(options.seed));
    if (referenceAudio) {
        form.set('ref_audio', new Blob([referenceAudio], { type: 'audio/wav' }), 'reference.wav');
        form.set('ref_text', options.refText ?? '');
    }
    return form;
}

function responseErrorMessage(response, body) {
    const detail = body.slice(0, 500).trim();
    return `Breeze returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
}

async function readResponseExcerpt(response, maxBytes = 500) {
    if (!response.body) {
        return '';
    }

    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (length < maxBytes) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const chunk = Buffer.from(value).subarray(0, maxBytes - length);
            chunks.push(chunk);
            length += chunk.length;
        }
        if (length === maxBytes) {
            await reader.cancel();
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, length).toString('utf8');
}

export async function pcmResponseToWav(response) {
    if (!response.ok) {
        let body = '';
        try {
            body = await readResponseExcerpt(response);
        } catch {
            // Use the status code when the remote error body cannot be read.
        }
        throw new BreezeUpstreamError(responseErrorMessage(response, body));
    }

    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'audio/pcm'
        || response.headers.get('x-sample-rate') !== '24000'
        || response.headers.get('x-sample-format')?.toLowerCase() !== 's16le') {
        throw new BreezeUpstreamError('Breeze returned an unsupported audio format; expected mono 24 kHz s16le PCM.');
    }
    if (!response.body) {
        throw new BreezeUpstreamError('Breeze returned an empty audio stream.');
    }

    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const chunk = Buffer.from(value);
            length += chunk.length;
            if (length > MAX_PCM_BYTES) {
                throw new BreezeUpstreamError(`Breeze audio exceeded the ${MAX_PCM_BYTES}-byte limit.`);
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }

    if (length === 0 || length % 2 !== 0 || length > 0xffffffff - 36) {
        throw new BreezeUpstreamError('Breeze returned an invalid PCM stream length.');
    }
    const pcm = Buffer.concat(chunks, length);
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + pcm.length, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24_000, 24);
    wav.writeUInt32LE(48_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, 44);
    return wav;
}

export async function synthesizeSpeech(input, referenceAudio, fetcher = fetch) {
    const options = validateSpeechOptions(input);
    const baseUrl = validateBreezeBaseUrl(input.endpoint);
    if (referenceAudio) {
        validateReferenceWav('reference.wav', referenceAudio);
    }

    let response;
    try {
        response = await fetcher(`${baseUrl}/v1/audio/speech`, {
            method: 'POST',
            body: createSpeechForm(options, referenceAudio),
            redirect: 'manual',
        });
    } catch (error) {
        throw new BreezeUpstreamError(`Could not connect to Breeze: ${error.message}`);
    }
    if (response.status >= 300 && response.status < 400) {
        throw new BreezeUpstreamError('Breeze redirected the request; redirects are not allowed.');
    }
    return pcmResponseToWav(response);
}

export function createSerialQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
        const result = tail.then(task, task);
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}
