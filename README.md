# SillyBreeze

SillyBreeze is a standalone SillyTavern TTS provider and server plugin for Breeze TTS voice cloning. It does not modify SillyTavern core or manage the Breeze model process.

## Install

Run the installer from the SillyTavern root directory. It clones this repository into a temporary directory, copies only the frontend extension and server plugin into their SillyTavern plugin folders, then removes the temporary clone:

```bash
curl -fsSL https://raw.githubusercontent.com/DigitalzombieTLD/SillyBreeze/main/install.sh -o /tmp/install-sillybreeze.sh
less /tmp/install-sillybreeze.sh
bash /tmp/install-sillybreeze.sh
```

The script requires Git and expects `server.js`, `public/`, and `plugins/` in the current directory. It installs:

- `extension/` to `public/scripts/extensions/third-party/sillybreeze/`
- `plugin/` to `plugins/sillybreeze/`

Enable the server plugin in SillyTavern's `config.yaml` by setting `enableServerPlugins: true`, then restart SillyTavern. The server plugin is disabled by default. In SillyTavern's TTS settings, select **SillyBreeze**.

The frontend registers the provider using the exported `registerTtsProvider` function in SillyTavern's TTS module. The current release accepts this registration and async iterable `Response` values, but this is a source-level integration point rather than a version-stable public API; a future SillyTavern change to that module may require an update. The server plugin uses SillyTavern's documented `info`/`init(router)` plugin interface.

## Configure

1. Start Breeze's persistent API process separately on the Breeze machine. SillyBreeze never starts, stops, or manages the model process.
2. Set **Breeze API base URL** to a URL reachable from the SillyTavern server. The default is `http://127.0.0.1:7860`; for separate machines, use Breeze's numeric LAN address, for example `http://192.168.1.25:7860`.
3. Upload one or more reference WAVs in the provider settings; each becomes a named voice. Enter each voice's exact transcript. The browser uploads the audio to SillyTavern's authenticated server plugin, which stores it under the current user's data; provider settings retain only opaque IDs, names, and transcripts. Assigned voices appear in SillyTavern's voice map (enable TTS first), alongside a built-in "Breeze default voice" that uses no reference. **Delete voice** removes the selected voice and its file.
4. Choose the CFG scale and deterministic seed. Defaults are `1` and `42`. Breeze only supports CFG other than `1` for requests with a leading instruction, so the plugin sends `cfg_scale=1` otherwise.

The Breeze server must accept connections from the SillyTavern server. The browser talks only to SillyTavern's same-origin authenticated plugin endpoint, so Breeze does not need browser CORS access. Use HTTPS if configured on the Breeze endpoint; plain HTTP sends text and reference audio unencrypted on the LAN. No API key is supported or required.

For SSRF protection, the server plugin accepts only HTTP(S) URLs with `localhost` or a numeric private/loopback IP address, rejects credentials and URL paths, and does not follow redirects. DNS hostnames (other than `localhost`) are intentionally not accepted, preventing DNS rebinding; configure a numeric LAN IP. The configured host and port are still trusted destinations, so only point SillyBreeze at a Breeze instance you control.

## Text options

- **Split blank-line paragraphs and parse leading Breeze instructions** is off by default. When enabled, each blank-line-delimited paragraph is sent sequentially. A leading tag such as `<instructions="Speak like a pirate.">` is removed from that paragraph and sent as Breeze's optional `instruction`; tagless paragraphs omit that field. SillyTavern's global **Narrate quoted text only** option also transforms text before provider processing, so disable it when Breeze should receive all original paragraphs and instruction tags.
- **Send only quoted text and parenthetical tags** is off by default. When enabled, SillyBreeze retains quoted spans and parenthetical spans such as `(sighs)`, in their original order, and sends those to Breeze. If SillyTavern's global **Narrate quoted text only** setting is enabled, it removes parenthetical text before provider processing; turn that global option off to use this Breeze-specific filter.

With both options off, SillyBreeze sends the incoming text unchanged. No global TTS queue or other provider is modified.
SillyTavern's global multi-voice mode can split a message into voice segments before the provider runs; disable it when you need each entire paragraph to become exactly one Breeze request.

## API and testing

The backend sends only Breeze's supported `POST /v1/audio/speech` multipart fields: `text`, optional `instruction`, `cfg_scale`, `seed`, and optional uploaded `ref_audio` plus `ref_text`. Inference is serialized because the Breeze API is single-concurrency. The server buffers each paragraph's mono 24 kHz signed 16-bit little-endian PCM stream and wraps it in a WAV container for SillyTavern playback.

Run the focused tests with Node.js 18 or newer:

```bash
npm test
```
