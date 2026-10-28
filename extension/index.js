import { getRequestHeaders } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getPreviewString, initVoiceMap, registerTtsProvider, saveTtsProviderSettings } from '../../tts/index.js';
import { extractQuotedAndParenthetical, parseInstructionParagraphs, splitParagraphs } from './logic.js';

const API_BASE = '/api/plugins/sillybreeze';
const PARAGRAPH_MARKER_START = '\uE000SILLYBREEZE_';
const PARAGRAPH_MARKER_END = '\uE001';
const REFERENCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_VOICE_ID = 'breeze-default';
const DEFAULT_VOICE_NAME = 'Breeze default voice';
let paragraphSequence = 0;

function randomSeed() {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
}

export class SillyBreezeTtsProvider {
    audioElement = document.createElement('audio');

    defaultSettings = {
        endpoint: 'http://127.0.0.1:7860',
        voices: [],
        cfgScale: 1,
        seed: 42,
        randomSeed: false,
        instructionFormat: 'angle',
        paragraphInstructions: false,
        quotedAndParentheticalOnly: false,
    };

    settingsHtml = `
        <div class="sillybreeze-settings">
            <label for="sillybreeze-endpoint">Breeze API base URL</label>
            <input id="sillybreeze-endpoint" class="text_pole" type="url" autocomplete="url" />
            <label for="sillybreeze-voice-select">Reference voices</label>
            <select id="sillybreeze-voice-select" class="text_pole"></select>
            <label for="sillybreeze-voice-name">Voice name</label>
            <input id="sillybreeze-voice-name" class="text_pole" type="text" />
            <label for="sillybreeze-reference-text">Exact reference transcript</label>
            <textarea id="sillybreeze-reference-text" class="text_pole" rows="3"></textarea>
            <label for="sillybreeze-reference">Add voice from reference WAV</label>
            <div class="sillybreeze-reference-row">
                <input id="sillybreeze-reference" type="file" accept=".wav,audio/wav,audio/x-wav" />
                <button id="sillybreeze-delete-reference" class="menu_button">Delete voice</button>
            </div>
            <div class="sillybreeze-number-row">
                <label for="sillybreeze-cfg-scale" title="Only applied to requests with a leading instruction; otherwise Breeze requires 1.">CFG scale</label>
                <input id="sillybreeze-cfg-scale" class="text_pole" type="number" min="0" max="100" step="0.1" />
                <label for="sillybreeze-seed">Seed</label>
                <input id="sillybreeze-seed" class="text_pole" type="number" min="0" max="4294967295" step="1" />
            </div>
            <label class="checkbox_label">
                <input id="sillybreeze-random-seed" type="checkbox" />
                <span>Randomize seed for every generation</span>
            </label>
            <label for="sillybreeze-instruction-format">Instruction tag format</label>
            <select id="sillybreeze-instruction-format" class="text_pole">
                <option value="angle">&lt;instruction="..."&gt;</option>
                <option value="square">[instruction="..."]</option>
                <option value="round">(instruction="...")</option>
            </select>
            <label class="checkbox_label">
                <input id="sillybreeze-paragraph-instructions" type="checkbox" />
                <span>Split blank-line paragraphs and parse leading Breeze instructions</span>
            </label>
            <label class="checkbox_label">
                <input id="sillybreeze-quoted-parenthetical" type="checkbox" />
                <span>Send only quoted text and parenthetical tags, such as (sighs)</span>
            </label>
            <small>When using the quoted-plus-parenthetical filter, turn off SillyTavern's global “Narrate quoted text only” option; it removes parenthetical text before Breeze can receive it.</small>
            <div id="sillybreeze-status" class="sillybreeze-status" role="status"></div>
        </div>`;

    constructor() {
        this.settings = { ...this.defaultSettings };
        this.pendingParagraphMarker = null;
    }

    get separator() {
        return ' ... ';
    }

    async loadSettings(settings) {
        this.settings = {
            ...this.defaultSettings,
            ...(settings && typeof settings === 'object' ? settings : {}),
        };
        const legacy = this.settings;
        if (REFERENCE_ID_PATTERN.test(legacy.referenceId) && !Array.isArray(settings?.voices)) {
            this.settings.voices = [{ id: legacy.referenceId, name: 'Reference voice', text: legacy.referenceText ?? '' }];
        }
        delete this.settings.referenceId;
        delete this.settings.referenceName;
        delete this.settings.referenceText;
        this.settings.voices = (Array.isArray(this.settings.voices) ? this.settings.voices : [])
            .filter(voice => voice && REFERENCE_ID_PATTERN.test(voice.id))
            .map(voice => ({ id: voice.id, name: String(voice.name || 'Reference voice'), text: String(voice.text ?? '') }));
        this.selectedVoiceId = this.settings.voices[0]?.id ?? '';
        this.settings.cfgScale = Number(this.settings.cfgScale);
        this.settings.seed = Number(this.settings.seed);
        this.settings.randomSeed = Boolean(this.settings.randomSeed);
        if (!['angle', 'square', 'round'].includes(this.settings.instructionFormat)) {
            this.settings.instructionFormat = 'angle';
        }
        this.settings.paragraphInstructions = Boolean(this.settings.paragraphInstructions);
        this.settings.quotedAndParentheticalOnly = Boolean(this.settings.quotedAndParentheticalOnly);
        this.bindSettings();
    }

    bindSettings() {
        $('#sillybreeze-endpoint').val(this.settings.endpoint);
        $('#sillybreeze-cfg-scale').val(this.settings.cfgScale);
        $('#sillybreeze-seed').val(this.settings.seed).prop('disabled', this.settings.randomSeed);
        $('#sillybreeze-random-seed').prop('checked', this.settings.randomSeed);
        $('#sillybreeze-instruction-format').val(this.settings.instructionFormat);
        $('#sillybreeze-paragraph-instructions').prop('checked', this.settings.paragraphInstructions);
        $('#sillybreeze-quoted-parenthetical').prop('checked', this.settings.quotedAndParentheticalOnly);
        this.renderVoices();

        $('#sillybreeze-endpoint').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.endpoint = String(event.currentTarget.value).trim();
            this.saveSettings();
        });
        $('#sillybreeze-voice-select').off('.sillybreeze').on('change.sillybreeze', event => {
            this.selectedVoiceId = String(event.currentTarget.value);
            this.renderVoices();
        });
        $('#sillybreeze-voice-name').off('.sillybreeze').on('change.sillybreeze', event => {
            const voice = this.getSelectedVoice();
            if (voice) {
                voice.name = String(event.currentTarget.value).trim() || 'Reference voice';
                this.renderVoices();
                this.saveSettings();
                this.refreshVoiceMap();
            }
        });
        $('#sillybreeze-reference-text').off('.sillybreeze').on('input.sillybreeze change.sillybreeze', event => {
            const voice = this.getSelectedVoice();
            if (voice) {
                voice.text = String(event.currentTarget.value);
                this.saveSettings();
            }
        });
        $('#sillybreeze-cfg-scale').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.cfgScale = Number(event.currentTarget.value);
            this.saveSettings();
        });
        $('#sillybreeze-seed').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.seed = Number(event.currentTarget.value);
            this.saveSettings();
        });
        $('#sillybreeze-random-seed').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.randomSeed = event.currentTarget.checked;
            $('#sillybreeze-seed').prop('disabled', this.settings.randomSeed);
            this.saveSettings();
        });
        $('#sillybreeze-instruction-format').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.instructionFormat = String(event.currentTarget.value);
            this.saveSettings();
        });
        $('#sillybreeze-paragraph-instructions').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.paragraphInstructions = event.currentTarget.checked;
            this.saveSettings();
        });
        $('#sillybreeze-quoted-parenthetical').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.quotedAndParentheticalOnly = event.currentTarget.checked;
            this.saveSettings();
        });
        $('#sillybreeze-reference').off('.sillybreeze').on('change.sillybreeze', event => {
            this.uploadReference(event.currentTarget.files?.[0]);
        });
        $('#sillybreeze-delete-reference').off('.sillybreeze').on('click.sillybreeze', () => {
            this.deleteReference();
        });
    }

    saveSettings() {
        saveTtsProviderSettings();
    }

    getSelectedVoice() {
        return this.settings.voices.find(voice => voice.id === this.selectedVoiceId);
    }

    renderVoices() {
        const select = $('#sillybreeze-voice-select').empty();
        for (const voice of this.settings.voices) {
            select.append($('<option />').val(voice.id).text(voice.name));
        }
        if (!this.settings.voices.length) {
            select.append($('<option />').val('').text('No reference voices uploaded'));
        }
        const voice = this.getSelectedVoice();
        select.val(voice?.id ?? '');
        $('#sillybreeze-voice-name').val(voice?.name ?? '').prop('disabled', !voice);
        $('#sillybreeze-reference-text').val(voice?.text ?? '').prop('disabled', !voice);
        $('#sillybreeze-delete-reference').prop('disabled', !voice);
    }

    refreshVoiceMap() {
        initVoiceMap().catch(error => console.warn('SillyBreeze: could not refresh voice map', error));
    }

    async requestJson(url, options = {}) {
        const headers = getRequestHeaders({ omitContentType: options.body instanceof FormData });
        const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
        if (!response.ok) {
            let detail = '';
            try {
                detail = (await response.json()).error ?? '';
            } catch {
                detail = await response.text().catch(() => '');
            }
            throw new Error(detail || `SillyBreeze server returned HTTP ${response.status}.`);
        }
        return response;
    }

    async uploadReference(file) {
        if (!file) {
            return;
        }
        $('#sillybreeze-status').text('Uploading reference WAV…');
        const form = new FormData();
        form.append('avatar', file);
        try {
            const response = await this.requestJson(`${API_BASE}/reference`, { method: 'POST', body: form });
            const reference = await response.json();
            const baseName = String(file.name).replace(/\.wav$/i, '').trim() || 'Reference voice';
            this.settings.voices.push({ id: reference.id, name: baseName, text: '' });
            this.selectedVoiceId = reference.id;
            this.renderVoices();
            this.saveSettings();
            this.refreshVoiceMap();
            $('#sillybreeze-status').text('Voice added. Enter the exact transcript of the reference audio.');
        } catch (error) {
            $('#sillybreeze-status').text(`Upload failed: ${error.message}`);
        } finally {
            $('#sillybreeze-reference').val('');
        }
    }

    async removeReference(id) {
        await this.requestJson(`${API_BASE}/reference/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    async deleteReference() {
        const voice = this.getSelectedVoice();
        if (!voice) {
            return;
        }
        $('#sillybreeze-status').text('Deleting voice…');
        try {
            await this.removeReference(voice.id);
            this.settings.voices = this.settings.voices.filter(item => item.id !== voice.id);
            this.selectedVoiceId = this.settings.voices[0]?.id ?? '';
            this.renderVoices();
            this.saveSettings();
            this.refreshVoiceMap();
            $('#sillybreeze-status').text('Voice deleted.');
        } catch (error) {
            $('#sillybreeze-status').text(`Delete failed: ${error.message}`);
        }
    }

    async processText(text) {
        this.pendingParagraphMarker = null;
        let output = String(text);
        if (this.settings.quotedAndParentheticalOnly) {
            output = extractQuotedAndParenthetical(output, this.settings.instructionFormat);
        }
        if (!this.settings.paragraphInstructions) {
            return output;
        }

        const paragraphs = splitParagraphs(output);
        const token = globalThis.crypto?.randomUUID?.()
            ?? `${Date.now().toString(36)}_${(++paragraphSequence).toString(36)}_${Math.random().toString(36).slice(2)}`;
        this.pendingParagraphMarker = `${PARAGRAPH_MARKER_START}${token}${PARAGRAPH_MARKER_END}`;
        return paragraphs.join(this.pendingParagraphMarker);
    }

    async checkReady() {
        if (!this.settings.endpoint) {
            throw new Error('Configure a Breeze API base URL.');
        }
    }

    async onRefreshClick() {
        await this.checkReady();
    }

    async fetchTtsVoiceObjects() {
        return [
            { name: DEFAULT_VOICE_NAME, voice_id: DEFAULT_VOICE_ID, lang: 'en' },
            ...this.settings.voices.map(voice => ({ name: voice.name, voice_id: voice.id, lang: 'en' })),
        ];
    }

    async getVoice(voiceName) {
        const voices = await this.fetchTtsVoiceObjects();
        return voices.find(voice => voice.voice_id === voiceName || voice.name === voiceName) ?? voices[0];
    }

    async previewTtsVoice(voiceId) {
        const audio = this.audioElement;
        audio.pause();
        audio.currentTime = 0;
        const generator = this.generateTts(getPreviewString(), voiceId);
        const { value: response, done } = await generator.next();
        if (done || !response?.ok) {
            throw new Error('Breeze could not generate a preview.');
        }
        const url = URL.createObjectURL(await response.blob());
        audio.src = url;
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
    }

    async *generateTts(text, voiceId) {
        const voice = this.settings.voices.find(item => item.id === voiceId || item.name === voiceId);
        if (voice && !voice.text.trim()) {
            throw new Error(`Voice "${voice.name}" needs its exact reference transcript.`);
        }

        let paragraphs;
        if (this.settings.paragraphInstructions) {
            const marker = this.pendingParagraphMarker;
            const parts = marker && String(text).includes(marker)
                ? String(text).split(marker)
                : splitParagraphs(text);
            paragraphs = parts.flatMap(part => parseInstructionParagraphs(part, true, this.settings.instructionFormat));
        } else {
            paragraphs = parseInstructionParagraphs(text, false);
        }

        if (!paragraphs.some(paragraph => paragraph.text.trim())) {
            throw new Error('No speech text remains after applying the selected filters.');
        }

        for (const paragraph of paragraphs) {
            const body = {
                endpoint: this.settings.endpoint,
                text: paragraph.text,
                cfg_scale: this.settings.cfgScale,
                seed: this.settings.randomSeed ? randomSeed() : this.settings.seed,
            };
            if (paragraph.instruction) {
                body.instruction = paragraph.instruction;
            }
            if (voice) {
                body.ref_audio_id = voice.id;
                body.ref_text = voice.text;
            }

            const response = await this.requestJson(`${API_BASE}/speech`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            yield response;
        }
    }
}

export async function init() {
    registerTtsProvider('SillyBreeze', SillyBreezeTtsProvider);
    // SillyTavern selects the stored provider before third-party providers register their option.
    if (extension_settings.tts?.currentProvider === 'SillyBreeze') {
        $('#tts_provider').val('SillyBreeze');
    }
}
