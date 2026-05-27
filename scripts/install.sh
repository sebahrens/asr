#!/bin/sh
# asr CLI installer (POSIX sh).
# Usage: ASR_FORGEJO_URL=https://forge.example sh install.sh [VERSION]
set -eu

FORGEJO_URL="${ASR_FORGEJO_URL:-https://forgejo.example.com}"
REPO="${ASR_REPO:-org/aks}"
VERSION="${1:-latest}"
DEST="${ASR_INSTALL_DIR:-$HOME/.local/bin}"

if [ "$VERSION" = "latest" ]; then
  ASSET_BASE="$FORGEJO_URL/$REPO/releases/latest/download"
else
  ASSET_BASE="$FORGEJO_URL/$REPO/releases/download/$VERSION"
fi

mkdir -p "$DEST"

curl -fsSL "$ASSET_BASE/asr.mjs" -o "$DEST/asr.mjs"
curl -fsSL "$ASSET_BASE/asr.mjs.sha256" -o "$DEST/asr.mjs.sha256"

EXPECTED=$(cut -d' ' -f1 < "$DEST/asr.mjs.sha256")
ACTUAL=$(shasum -a 256 "$DEST/asr.mjs" | cut -d' ' -f1)
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "SHA-256 mismatch: expected $EXPECTED got $ACTUAL" >&2
  rm -f "$DEST/asr.mjs" "$DEST/asr.mjs.sha256"
  exit 1
fi
rm -f "$DEST/asr.mjs.sha256"

printf '#!/bin/sh\nexec node "%s/asr.mjs" "$@"\n' "$DEST" > "$DEST/asr"
chmod +x "$DEST/asr"

echo "Installed asr to $DEST/asr"
echo "Make sure $DEST is on your PATH."
