#!/bin/sh
# Builds the standalone command-line program, dist/protect, for this Mac's CPU.
# Uses the official Node.js binary, since Homebrew's depends on other Homebrew
# libraries and would not run on another Mac.
set -eu
cd "$(dirname "$0")/.."

NODE_VERSION=$(node -v)
case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac

DIST=dist
TARBALL="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
CACHE="$DIST/node-$NODE_VERSION-$ARCH"
BASE_URL="https://nodejs.org/dist/$NODE_VERSION"

mkdir -p "$CACHE"
npx esbuild bin/protect.js --bundle --platform=node --format=cjs --log-level=warning --outfile="$DIST/protect.cjs"

if [ ! -x "$CACHE/node" ]; then
  curl -fsSL "$BASE_URL/$TARBALL" -o "$CACHE/$TARBALL"
  EXPECTED=$(curl -fsSL "$BASE_URL/SHASUMS256.txt" | awk -v f="$TARBALL" '$2 == f { print $1 }')
  ACTUAL=$(shasum -a 256 "$CACHE/$TARBALL" | awk '{ print $1 }')
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Checksum mismatch for $TARBALL" >&2
    exit 1
  fi
  tar -xzf "$CACHE/$TARBALL" -C "$CACHE" --strip-components=2 "node-$NODE_VERSION-darwin-$ARCH/bin/node"
  rm "${CACHE:?}/${TARBALL:?}"
fi

cat > "$DIST/sea-config.json" <<JSON
{
  "main": "$DIST/protect.cjs",
  "output": "$DIST/protect",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
JSON
"$CACHE/node" --build-sea "$DIST/sea-config.json"
codesign --force --sign - "$DIST/protect"
echo "Built $DIST/protect"
