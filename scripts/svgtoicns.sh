#!/bin/bash

# Check if svg2png is installed
if ! command -v svg2png &> /dev/null; then
    echo "svg2png could not be found, please install it first."
    exit
fi

# Check if iconutil is available (macOS only)
if ! command -v iconutil &> /dev/null; then
    echo "iconutil could not be found, please run this on macOS."
    exit
fi

# Create iconset directory
ICONSET_DIR="../build/icons/icon.iconset"
mkdir -p "$ICONSET_DIR"

# Define standard macOS icon sizes
# Format: icon_<size>x<size>.png and icon_<size>x<size>@2x.png
svg2png -w 16 -h 16 ../logo.svg "$ICONSET_DIR/icon_16x16.png"
svg2png -w 32 -h 32 ../logo.svg "$ICONSET_DIR/icon_16x16@2x.png"
svg2png -w 32 -h 32 ../logo.svg "$ICONSET_DIR/icon_32x32.png"
svg2png -w 64 -h 64 ../logo.svg "$ICONSET_DIR/icon_32x32@2x.png"
svg2png -w 128 -h 128 ../logo.svg "$ICONSET_DIR/icon_128x128.png"
svg2png -w 256 -h 256 ../logo.svg "$ICONSET_DIR/icon_128x128@2x.png"
svg2png -w 256 -h 256 ../logo.svg "$ICONSET_DIR/icon_256x256.png"
svg2png -w 512 -h 512 ../logo.svg "$ICONSET_DIR/icon_256x256@2x.png"
svg2png -w 512 -h 512 ../logo.svg "$ICONSET_DIR/icon_512x512.png"
svg2png -w 1024 -h 1024 ../logo.svg "$ICONSET_DIR/icon_512x512@2x.png"

# Convert to ICNS
iconutil -c icns "$ICONSET_DIR" -o "../build/icons/icon.icns"

# Clean up
rm -r "$ICONSET_DIR"

echo "ICNS file created at build/icons/icon.icns"