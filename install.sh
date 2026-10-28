#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f server.js || ! -d public || ! -d plugins ]]; then
    echo "Run this installer from the SillyTavern root directory." >&2
    exit 1
fi

if ! command -v git >/dev/null 2>&1; then
    echo "Git is required to download SillyBreeze." >&2
    exit 1
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT

git clone --depth 1 https://github.com/DigitalzombieTLD/SillyBreeze.git "$temporary_directory/SillyBreeze"

extension_target="public/scripts/extensions/third-party/sillybreeze"
plugin_target="plugins/sillybreeze"
mkdir -p "$extension_target" "$plugin_target"
cp -a "$temporary_directory/SillyBreeze/extension/." "$extension_target/"
cp -a "$temporary_directory/SillyBreeze/plugin/." "$plugin_target/"

echo "SillyBreeze files installed."
echo "Enable enableServerPlugins in config.yaml, then restart SillyTavern."
