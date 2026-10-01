#!/bin/sh
# Wraps the packaged app in a drag-to-Applications DMG using only built-in macOS tools.
set -eu

APP="dist/Prompt Manager-darwin-arm64/Prompt Manager.app"
VERSION=$(node -p "require('./package.json').version")
OUT="dist/Prompt-Manager-$VERSION-arm64.dmg"

# Ad-hoc signature: Apple Silicon refuses to run unsigned code. This is not a Developer ID
# signature, so Gatekeeper still asks the user to confirm the first launch.
codesign --force --deep --sign - "$APP"

STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Prompt Manager" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "${STAGE:?}"
echo "Built $OUT"
