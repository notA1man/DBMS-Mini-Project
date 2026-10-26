#!/usr/bin/env bash
# Regenerates the landing-page takeoff sequence from the source video (quick, CPU-only fallback;
# the shipped frames come from scripts/upscale-flight-frames.sh).
#   usage: scripts/extract-flight-frames.sh path/to/video.mp4
# Output: public/flight/d/000-239.webp (1920w, 24 fps) and public/flight/m/000-119.webp (960w, 12 fps).
# delogo removes the generator watermark in the bottom-right corner; the 720p source is
# upscaled with lanczos + a light unsharp mask, which looks crisper than the browser upscaling it.
set -euo pipefail

SRC="${1:?usage: $0 path/to/video.mp4}"
OUT="$(dirname "$0")/../public/flight"
LOGO="delogo=x=1128:y=566:w=66:h=68"

SHARP="unsharp=5:5:0.7:5:5:0"

mkdir -p "$OUT/d" "$OUT/m"
ffmpeg -v error -y -i "$SRC" -vf "$LOGO,scale=1920:1080:flags=lanczos,$SHARP" \
  -start_number 0 -c:v libwebp -quality 84 -compression_level 6 "$OUT/d/%03d.webp"
ffmpeg -v error -y -i "$SRC" -vf "$LOGO,fps=12,scale=960:540:flags=lanczos,$SHARP" \
  -start_number 0 -c:v libwebp -quality 80 -compression_level 6 "$OUT/m/%03d.webp"

echo "desktop: $(ls "$OUT/d" | wc -l) frames, mobile: $(ls "$OUT/m" | wc -l) frames"
