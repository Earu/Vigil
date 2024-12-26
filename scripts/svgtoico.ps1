# Check if Inkscape is installed
if (-not (Get-Command inkscape -ErrorAction SilentlyContinue)) {
    Write-Host "Inkscape is not installed. Please install it first."
    exit
}

# Check if ImageMagick is installed
if (-not (Get-Command magick -ErrorAction SilentlyContinue)) {
    Write-Host "ImageMagick is not installed. Please install it first."
    exit
}

# Define paths
$svgPath = "logo.svg"
$outputDir = "build/icons"
$iconPath = Join-Path $outputDir "icon.ico"

# Create output directory if it doesn't exist
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}

# Define resolutions
$resolutions = @(16, 32, 48, 64, 128, 256)

# Convert SVG to PNGs at each resolution
foreach ($res in $resolutions) {
    $pngPath = Join-Path $outputDir "icon_${res}x${res}.png"
    inkscape $svgPath --export-type="png" --export-width=$res --export-height=$res --export-filename=$pngPath
}

# Convert PNGs to ICO
$pngFiles = $resolutions | ForEach-Object { Join-Path $outputDir "icon_${_}x${_}.png" }
magick convert $pngFiles -colors 256 $iconPath

# Clean up PNG files
Remove-Item $pngFiles

Write-Host "ICO file created at $iconPath"