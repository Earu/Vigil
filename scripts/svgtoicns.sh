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
ICONSET_DIR="build/icons/icon.iconset"
mkdir -p "$ICONSET_DIR"

# Define resolutions
RESOLUTIONS=(16 32 64 128 256 512 1024)

# Convert SVG to PNGs at each resolution
for RES in "${RESOLUTIONS[@]}"; do
    svg2png -w $RES -h $RES logo.svg "$ICONSET_DIR/icon_${RES}x${RES}.png"
done

# Convert to ICNS
iconutil -c icns "$ICONSET_DIR" -o "build/icons/icon.icns"

# Clean up
rm -r "$ICONSET_DIR"

echo "ICNS file created at build/icons/icon.icns"