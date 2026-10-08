#!/bin/sh
# Wraps the packaged app in a drag-to-Applications DMG using only built-in macOS tools.
# With SIGN_IDENTITY set (release builds in CI), the app was already signed with Developer ID by
# `npm run dist -- --osx-sign.identity=...`, and the DMG is signed, notarized and stapled here.
# APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER must then be set for notarytool.
set -eu

APP="dist/Prompt Manager-darwin-arm64/Prompt Manager.app"
VERSION=$(node -p "require('./package.json').version")
OUT="dist/Prompt-Manager-$VERSION-arm64.dmg"

if [ -z "${SIGN_IDENTITY:-}" ]; then
  # Ad-hoc signature: Apple Silicon refuses to run unsigned code. This is not a Developer ID
  # signature, so Gatekeeper still asks the user to confirm the first launch.
  codesign --force --deep --sign - "$APP"
fi

STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Prompt Manager" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "${STAGE:?}"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --sign "$SIGN_IDENTITY" --timestamp "$OUT"
  # Notarizing the DMG covers the app inside it. stapler fails unless Apple accepted the submission.
  xcrun notarytool submit "$OUT" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple "$OUT"
fi
echo "Built $OUT"
