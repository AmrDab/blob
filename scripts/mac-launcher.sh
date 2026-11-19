#!/bin/sh
# Builds Blob.app's own program (macos/blob-launch.swift) into assets/mac/blob-launch, for Apple silicon and Intel.
# Run on a Mac with Xcode or its command line tools, only when the Swift file changes: the result is committed, so a
# user's Mac needs no compiler. Every user's Blob.app then carries this same program (launcher.ts).
#   BLOB_SIGN_ID="Developer ID Application: …"  signs it with that identity (hardened runtime, timestamp) for notarizing.
set -eu
cd "$(dirname "$0")/.."
out=assets/mac/blob-launch
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" -o "$tmp/$arch" macos/blob-launch.swift
done
mkdir -p assets/mac
lipo -create -output "$out" "$tmp/arm64" "$tmp/x86_64"
chmod 755 "$out"
if [ -n "${BLOB_SIGN_ID:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$BLOB_SIGN_ID" "$out"
else
  codesign --force --sign - "$out"
fi
lipo -info "$out"
