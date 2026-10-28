import { getRequestHeaders } from '../../../../script.js';
import { getPreviewString, registerTtsProvider, saveTtsProviderSettings } from '../../tts/index.js';
import { extractQuotedAndParenthetical, parseInstructionParagraphs, splitParagraphs } from './logic.js';

const API_BASE = '/api/plugins/sillybreeze';
const PARAGRAPH_MARKER_START = '\uE000SILLYBREEZE_';
const PARAGRAPH_MARKER_END = '\uE001';
const REFERENCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let paragraphSequence = 0;

export class SillyBreezeTtsProvider {
    audioElement = document.createElement('audio');

    defaultSettings = {
        endpoint: 'http://127.0.0.1:7860',
        referenceId: '',
        referenceName: '',
        referenceText: '',
        cfgScale: 1,
        seed: 42,
        paragraphInstructions: false,
        quotedAndParentheticalOnly: false,
    };

    settingsHtml = `
        <div class="sillybreeze-settings">
            <label for="sillybreeze-endpoint">Breeze API base URL</label>
            <input id="sillybreeze-endpoint" class="text_pole" type="url" autocomplete="url" />
            <label for="sillybreeze-reference">Reference WAV</label>
            <div class="sillybreeze-reference-row">
                <input id="sillybreeze-reference" type="file" accept=".wav,audio/wav,audio/x-wav" />
                <button id="sillybreeze-delete-reference" class="menu_button">Delete reference</button>
            </div>
            <div id="sillybreeze-reference-name" class="sillybreeze-status"></div>
            <label for="sillybreeze-reference-text">Exact reference transcript</label>
            <textarea id="sillybreeze-reference-text" class="text_pole" rows="3"></textarea>
            <div class="sillybreeze-number-row">
                <label for="sillybreeze-cfg-scale">CFG scale</label>
                <input id="sillybreeze-cfg-scale" class="text_pole" type="number" min="0" max="100" step="0.1" />
                <label for="sillybreeze-seed">Seed</label>
                <input id="sillybreeze-seed" class="text_pole" type="number" min="0" max="4294967295" step="1" />
            </div>
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
        if (!REFERENCE_ID_PATTERN.test(this.settings.referenceId)) {
            this.settings.referenceId = '';
            this.settings.referenceName = '';
        }
        this.settings.cfgScale = Number(this.settings.cfgScale);
        this.settings.seed = Number(this.settings.seed);
        this.settings.paragraphInstructions = Boolean(this.settings.paragraphInstructions);
        this.settings.quotedAndParentheticalOnly = Boolean(this.settings.quotedAndParentheticalOnly);
        this.bindSettings();
    }

    bindSettings() {
        $('#sillybreeze-endpoint').val(this.settings.endpoint);
        $('#sillybreeze-reference-text').val(this.settings.referenceText);
        $('#sillybreeze-cfg-scale').val(this.settings.cfgScale);
        $('#sillybreeze-seed').val(this.settings.seed);
        $('#sillybreeze-paragraph-instructions').prop('checked', this.settings.paragraphInstructions);
        $('#sillybreeze-quoted-parenthetical').prop('checked', this.settings.quotedAndParentheticalOnly);
        this.updateReferenceLabel();

        $('#sillybreeze-endpoint').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.endpoint = String(event.currentTarget.value).trim();
            this.saveSettings();
        });
        $('#sillybreeze-reference-text').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.referenceText = String(event.currentTarget.value);
            this.saveSettings();
        });
        $('#sillybreeze-cfg-scale').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.cfgScale = Number(event.currentTarget.value);
            this.saveSettings();
        });
        $('#sillybreeze-seed').off('.sillybreeze').on('change.sillybreeze', event => {
            this.settings.seed = Number(event.currentTarget.value);
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

    updateReferenceLabel() {
        $('#sillybreeze-reference-name').text(this.settings.referenceName
            ? `Selected: ${this.settings.referenceName}`
            : 'No reference WAV uploaded.');
        $('#sillybreeze-delete-reference').prop('disabled', !this.settings.referenceId);
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
            const previousId = this.settings.referenceId;
            this.settings.referenceId = reference.id;
            this.settings.referenceName = reference.name;
            this.updateReferenceLabel();
            this.saveSettings();
            if (previousId && previousId !== reference.id) {
                await this.removeReference(previousId).catch(() => {});
            }
            $('#sillybreeze-status').text('Reference WAV uploaded.');
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
        if (!this.settings.referenceId) {
            return;
        }
        $('#sillybreeze-status').text('Deleting reference WAV…');
        try {
            await this.removeReference(this.settings.referenceId);
            this.settings.referenceId = '';
            this.settings.referenceName = '';
            this.updateReferenceLabel();
            this.saveSettings();
            $('#sillybreeze-status').text('Reference WAV deleted.');
        } catch (error) {
            $('#sillybreeze-status').text(`Delete failed: ${error.message}`);
        }
    }

    async processText(text) {
        this.pendingParagraphMarker = null;
        let output = String(text);
        if (this.settings.quotedAndParentheticalOnly) {
            output = extractQuotedAndParenthetical(output);
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
        return [{ name: 'Breeze reference voice', voice_id: 'breeze-reference', lang: 'en' }];
    }

    async getVoice(voiceName) {
        return { name: voiceName, voice_id: 'breeze-reference', lang: 'en' };
    }

    async previewTtsVoice() {
        const audio = this.audioElement;
        audio.pause();
        audio.currentTime = 0;
        const generator = this.generateTts(getPreviewString());
        const { value: response, done } = await generator.next();
        if (done || !response?.ok) {
            throw new Error('Breeze could not generate a preview.');
        }
        const url = URL.createObjectURL(await response.blob());
        audio.src = url;
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
    }

    async *generateTts(text) {
        let paragraphs;
        if (this.settings.paragraphInstructions) {
            const marker = this.pendingParagraphMarker;
            const parts = marker && String(text).includes(marker)
                ? String(text).split(marker)
                : splitParagraphs(text);
            paragraphs = parts.flatMap(part => parseInstructionParagraphs(part, true));
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
                seed: this.settings.seed,
            };
            if (paragraph.instruction) {
                body.instruction = paragraph.instruction;
            }
            if (this.settings.referenceId) {
                body.ref_audio_id = this.settings.referenceId;
                body.ref_text = this.settings.referenceText;
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
}
