#!/bin/sh
# Builds dist/Password Protect.app and a .dmg for this Mac's CPU.
# Uses the official Node.js binary, since Homebrew's depends on other Homebrew
# libraries and would not run on another Mac.
set -eu
cd "$(dirname "$0")/.."

NAME="Password Protect"
VERSION=$(node -p "require('./package.json').version")
NODE_VERSION=$(node -v)
case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac

DIST=dist
APP="$DIST/$NAME.app"
TARBALL="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
CACHE="$DIST/node-$NODE_VERSION-$ARCH"
BASE_URL="https://nodejs.org/dist/$NODE_VERSION"

rm -rf "$APP" "$DIST/protect" "$DIST"/*.dmg
mkdir -p "$CACHE"

echo "Bundling"
npx esbuild bin/protect.js --bundle --platform=node --format=cjs --log-level=warning --outfile="$DIST/protect.cjs"

if [ ! -x "$CACHE/node" ]; then
  echo "Downloading official Node $NODE_VERSION ($ARCH)"
  curl -fsSL "$BASE_URL/$TARBALL" -o "$CACHE/$TARBALL"
  EXPECTED=$(curl -fsSL "$BASE_URL/SHASUMS256.txt" | awk -v f="$TARBALL" '$2 == f { print $1 }')
  ACTUAL=$(shasum -a 256 "$CACHE/$TARBALL" | awk '{ print $1 }')
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Checksum mismatch for $TARBALL" >&2
    exit 1
  fi
  tar -xzf "$CACHE/$TARBALL" -C "$CACHE" --strip-components=2 "node-$NODE_VERSION-darwin-$ARCH/bin/node"
  rm "$CACHE/$TARBALL"
fi

echo "Building standalone program"
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

echo "Building app"
osacompile -o "$APP" macos/app.applescript
cp "$DIST/protect" "$APP/Contents/Resources/protect"

# A reserved word used as a variable compiles fine and only fails when run.
# Raw codes like <<class RApw>> in the compiled script are how that shows up.
if osadecompile "$APP/Contents/Resources/Scripts/main.scpt" | grep -q '«class'; then
  echo "Reserved AppleScript word used in macos/app.applescript:" >&2
  osadecompile "$APP/Contents/Resources/Scripts/main.scpt" | grep '«class' >&2
  exit 1
fi

PLIST="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST"; }
pb "Delete :CFBundleDocumentTypes" 2>/dev/null || true
pb "Add :CFBundleIdentifier string local.password-protect" 2>/dev/null || pb "Set :CFBundleIdentifier local.password-protect"
pb "Add :CFBundleShortVersionString string $VERSION" 2>/dev/null || pb "Set :CFBundleShortVersionString $VERSION"
pb "Add :CFBundleDocumentTypes array"
# .locked files open here on double-click.
pb "Add :CFBundleDocumentTypes:0 dict"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeName string 'Locked Item'"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor"
pb "Add :CFBundleDocumentTypes:0:LSHandlerRank string Owner"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string locked"
# Anything else can be dropped on the app or reached from Open With, without
# becoming the default app for it.
pb "Add :CFBundleDocumentTypes:1 dict"
pb "Add :CFBundleDocumentTypes:1:CFBundleTypeName string 'Any File or Folder'"
pb "Add :CFBundleDocumentTypes:1:CFBundleTypeRole string Viewer"
pb "Add :CFBundleDocumentTypes:1:LSHandlerRank string Alternate"
pb "Add :CFBundleDocumentTypes:1:LSItemContentTypes array"
pb "Add :CFBundleDocumentTypes:1:LSItemContentTypes:0 string public.item"
pb "Add :CFBundleDocumentTypes:1:LSItemContentTypes:1 string public.folder"

codesign --force --deep --sign - "$APP"

echo "Building disk image"
STAGE="$DIST/dmg"
rm -rf "$STAGE"
mkdir "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGE" -format UDZO "$DIST/$NAME-$VERSION-$ARCH.dmg"
rm -rf "$STAGE"

echo "Testing app flow"
PROTECT_HISTORY_DIR=$(mktemp -d) osascript macos/test-flow.applescript "$PWD/$APP"

echo "Done: $APP"
