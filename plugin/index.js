import fs from 'node:fs/promises';
import multer from 'multer';
import {
    BreezeUpstreamError,
    MAX_REFERENCE_BYTES,
    createSerialQueue,
    deleteReferenceWav,
    getAuthenticatedUserDirectories,
    getReferencePath,
    storeReferenceWav,
    synthesizeSpeech,
    validateReferenceWav,
} from './core.js';

export const info = {
    id: 'sillybreeze',
    name: 'SillyBreeze',
    description: 'Authenticated reference audio storage and Breeze TTS proxy.',
};

const inferenceQueue = createSerialQueue();
const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_REFERENCE_BYTES, files: 1, fields: 0 },
});

function isAuthenticated(request) {
    try {
        getAuthenticatedUserDirectories(request);
        return true;
    } catch {
        return false;
    }
}

function sendError(response, status, error) {
    return response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

function uploadSingleReference(request, response, next) {
    uploader.single('reference')(request, response, error => {
        if (!error) {
            return next();
        }
        const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return sendError(response, status, error);
    });
}

export async function init(router) {
    router.post('/reference', uploadSingleReference, async (request, response) => {
        if (!isAuthenticated(request)) {
            return response.sendStatus(403);
        }
        if (!request.file) {
            return sendError(response, 400, 'Upload one WAV file in the reference field.');
        }

        try {
            const directories = getAuthenticatedUserDirectories(request);
            const reference = await storeReferenceWav(directories, request.file.originalname, request.file.buffer);
            return response.json(reference);
        } catch (error) {
            return sendError(response, 400, error);
        }
    });

    router.delete('/reference/:id', async (request, response) => {
        if (!isAuthenticated(request)) {
            return response.sendStatus(403);
        }
        try {
            await deleteReferenceWav(getAuthenticatedUserDirectories(request), request.params.id);
            return response.sendStatus(204);
        } catch (error) {
            return sendError(response, 400, error);
        }
    });

    router.post('/speech', async (request, response) => {
        if (!isAuthenticated(request)) {
            return response.sendStatus(403);
        }
        try {
            let referenceAudio;
            if (request.body?.ref_audio_id) {
                const directories = getAuthenticatedUserDirectories(request);
                const resolved = getReferencePath(directories, request.body.ref_audio_id);
                const fileStat = await fs.stat(resolved.filePath);
                if (fileStat.size > MAX_REFERENCE_BYTES) {
                    throw new Error('Stored reference WAV exceeds the upload size limit.');
                }
                referenceAudio = await fs.readFile(resolved.filePath);
                validateReferenceWav('reference.wav', referenceAudio);
            }

            const wav = await inferenceQueue(() => synthesizeSpeech(request.body, referenceAudio));
            response.set('Content-Type', 'audio/wav');
            response.set('Content-Length', String(wav.length));
            response.set('Cache-Control', 'no-store');
            return response.status(200).send(wav);
        } catch (error) {
            const status = error instanceof BreezeUpstreamError ? 502 : 400;
            return sendError(response, status, error);
        }
    });
}
