#!/bin/sh
# asr CLI installer (POSIX sh).
# Usage: ASR_FORGEJO_URL=https://forge.example sh install.sh [VERSION]
set -eu

FORGEJO_URL="${ASR_FORGEJO_URL:-https://forgejo.example.com}"
REPO="${ASR_REPO:-org/aks}"
VERSION="${1:-latest}"
DEST="${ASR_INSTALL_DIR:-$HOME/.local/bin}"
ALLOW_INSECURE="${ASR_ALLOW_INSECURE_INSTALL:-0}"
PUBLIC_KEY_PEM="${ASR_INSTALL_PUBLIC_KEY_PEM:-$(cat <<'EOF'
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzSx3tw5U78hJdXcc773k
pxJk4WlD8+mMeN4ke7KUaF4AKCAgsEp4kjVj/cornoebWTlWp0aEhhuwrUjQ9fgE
FkgFYm1EJHefypMQyEINTLiXfI3aIVfrL6GioI5QMS8ZEI6M5gspNiWuFVTcg8Gz
sd5fXNgwYjUOcnXKM/aanVm3uD9dOufz4NCHfXNbr2Q239OVUndgivEwHXL8ry98
W5FgLiSdVzJnHXNgZvfgAyHHlY57xSnhjL7qMTVhLt5KzCg4AbB/Ok6gRjI21FZk
a/Vjpd7g5q9GquY7ukAnQjnT3VY/kbiDxb9KdiIc4v6paHj/PadzDg1plmxOXKNE
KQIDAQAB
-----END PUBLIC KEY-----
EOF
)}"

case "$FORGEJO_URL" in
  https://*) ;;
  *)
    if [ "$ALLOW_INSECURE" != "1" ]; then
      echo "Refusing non-HTTPS release URL: set ASR_ALLOW_INSECURE_INSTALL=1 only for local development." >&2
      exit 1
    fi
    ;;
esac

if [ "$VERSION" = "latest" ]; then
  ASSET_BASE="$FORGEJO_URL/$REPO/releases/latest/download"
else
  ASSET_BASE="$FORGEJO_URL/$REPO/releases/download/$VERSION"
fi

mkdir -p "$DEST"

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/asr-install.XXXXXX")
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT HUP TERM

ASR_TMP="$TMP_DIR/asr.mjs"
SHA_TMP="$TMP_DIR/asr.mjs.sha256"
SIG_TMP="$TMP_DIR/asr.mjs.sig"
KEY_TMP="$TMP_DIR/asr-release.pub"

printf '%s\n' "$PUBLIC_KEY_PEM" > "$KEY_TMP"

curl -fsSL "$ASSET_BASE/asr.mjs" -o "$ASR_TMP"
curl -fsSL "$ASSET_BASE/asr.mjs.sha256" -o "$SHA_TMP"
curl -fsSL "$ASSET_BASE/asr.mjs.sig" -o "$SIG_TMP"

EXPECTED=$(cut -d' ' -f1 < "$SHA_TMP")
ACTUAL=$(shasum -a 256 "$ASR_TMP" | cut -d' ' -f1)
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "SHA-256 mismatch: expected $EXPECTED got $ACTUAL" >&2
  exit 1
fi

if ! openssl dgst -sha256 -verify "$KEY_TMP" -signature "$SIG_TMP" "$ASR_TMP" >/dev/null 2>&1; then
  echo "Signature verification failed for asr.mjs" >&2
  exit 1
fi

mv -f "$ASR_TMP" "$DEST/asr.mjs"

printf '#!/bin/sh\nexec node "%s/asr.mjs" "$@"\n' "$DEST" > "$DEST/asr"
chmod +x "$DEST/asr"

echo "Installed asr to $DEST/asr"
echo "Make sure $DEST is on your PATH."
