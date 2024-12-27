#!/bin/bash

# Check if Inkscape is installed
if ! command -v inkscape &> /dev/null; then
    echo "Inkscape could not be found, please install it first."
    exit
fi

# Create icons directory
OUTPUT_DIR="../build/icons"
mkdir -p "$OUTPUT_DIR"

# Define resolutions needed for Linux
# Common sizes used in Linux desktop environments
RESOLUTIONS=(16 24 32 48 64 96 128 256 512 1024)

# Convert SVG to PNGs at each resolution
for RES in "${RESOLUTIONS[@]}"; do
    echo "Generating ${RES}x${RES} PNG..."
    inkscape "../logo.svg" --export-type="png" \
        --export-width=$RES \
        --export-height=$RES \
        --export-filename="$OUTPUT_DIR/icon_${RES}x${RES}.png"
done

# Create a symbolic link for the default icon size (256x256 is commonly used)
ln -sf "$OUTPUT_DIR/icon_256x256.png" "$OUTPUT_DIR/icon.png"

echo "PNG files created in $OUTPUT_DIR"