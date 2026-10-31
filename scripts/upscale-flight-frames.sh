#!/usr/bin/env bash
# AI-upscales the landing-page takeoff video with Real-ESRGAN and rebuilds public/flight/{d,m}.
# Uses realesrgan-ncnn-vulkan (any Vulkan GPU, no Python/CUDA). Run it on the machine with the GPU:
#
#   scripts/upscale-flight-frames.sh path/to/video.mp4
#
# Options (env vars):
#   MODEL=realesrgan-x4plus   real-world model (default). Faster, softer: realesr-animevideov3
#   DESKTOP_W=1920            desktop frame width (2560 for 1440p+ screens; ~2x the download)
#   GPU=0                     Vulkan device id (see the binary's startup log)
#   REALESRGAN_BIN=...        use an existing realesrgan-ncnn-vulkan instead of downloading one
#
# Needs: ffmpeg (with libwebp), curl, unzip, and a Vulkan driver
# (Arch + NVIDIA: `sudo pacman -S --needed vulkan-icd-loader nvidia-utils`).
set -euo pipefail

SRC="$(realpath "${1:?usage: $0 path/to/video.mp4}")"
MODEL="${MODEL:-realesrgan-x4plus}"
DESKTOP_W="${DESKTOP_W:-1920}"
DESKTOP_H=$((DESKTOP_W * 9 / 16))
GPU="${GPU:-0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/flight"
LOGO="delogo=x=1128:y=566:w=66:h=68" # generator watermark, bottom-right
BATCH=24                             # frames per GPU pass; keeps 4x PNGs on disk small

# ---- Real-ESRGAN binary (cached outside the repo) --------------------------------------
TOOLS="${XDG_CACHE_HOME:-$HOME/.cache}/strata-realesrgan"
if [[ -n "${REALESRGAN_BIN:-}" ]]; then
  BIN="$REALESRGAN_BIN"
  MODELS="${REALESRGAN_MODELS:-$(dirname "$BIN")/models}"
else
  BIN="$TOOLS/realesrgan-ncnn-vulkan"
  MODELS="$TOOLS/models"
  if [[ ! -x "$BIN" ]]; then
    echo "Downloading realesrgan-ncnn-vulkan v0.2.5.0 to $TOOLS ..."
    mkdir -p "$TOOLS"
    curl -fL --progress-bar -o "$TOOLS/realesrgan.zip" \
      https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip
    unzip -oq "$TOOLS/realesrgan.zip" -d "$TOOLS"
    chmod +x "$BIN"
  fi
fi

SCALE=4
[[ "$MODEL" == realesr-animevideov3 ]] && MODEL="realesr-animevideov3-x4"

# ---- work dirs ---------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/strata-upscale.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/src" "$WORK/batch" "$WORK/up" "$WORK/d" "$WORK/m"

echo "Extracting frames (watermark removed) ..."
ffmpeg -v error -y -i "$SRC" -vf "$LOGO" -start_number 0 "$WORK/src/%03d.png"
mapfile -t FRAMES < <(cd "$WORK/src" && ls *.png | sort)
TOTAL=${#FRAMES[@]}
echo "$TOTAL frames -> $MODEL x$SCALE on GPU $GPU, desktop ${DESKTOP_W}x${DESKTOP_H}"

START=$SECONDS
for ((b = 0; b < TOTAL; b += BATCH)); do
  find "$WORK/batch" "$WORK/up" -type f -delete
  # real copies: realesrgan-ncnn-vulkan only picks up regular files (it skips symlinks)
  for f in "${FRAMES[@]:b:BATCH}"; do cp "$WORK/src/$f" "$WORK/batch/$f"; done

  "$BIN" -i "$WORK/batch" -o "$WORK/up" -n "$MODEL" -m "$MODELS" -s "$SCALE" -g "$GPU" -f png >/dev/null 2>"$WORK/esrgan.log" || {
    cat "$WORK/esrgan.log" >&2
    echo "Real-ESRGAN failed (see log above). On Arch: sudo pacman -S --needed vulkan-icd-loader nvidia-utils" >&2
    exit 1
  }

  for f in "${FRAMES[@]:b:BATCH}"; do
    i=$((10#${f%.png}))
    [[ -f "$WORK/up/$f" ]] || {
      echo "missing upscaled frame $f — Real-ESRGAN log:" >&2
      cat "$WORK/esrgan.log" >&2
      exit 1
    }
    ffmpeg -v error -y -i "$WORK/up/$f" -vf "scale=${DESKTOP_W}:${DESKTOP_H}:flags=lanczos" \
      -c:v libwebp -quality 86 -compression_level 6 "$WORK/d/$f.webp"
    if ((i % 2 == 0)); then # mobile set: every other frame (12 fps)
      ffmpeg -v error -y -i "$WORK/up/$f" -vf "scale=960:540:flags=lanczos" \
        -c:v libwebp -quality 80 -compression_level 6 "$WORK/m/$(printf %03d $((i / 2))).webp"
    fi
  done

  done_n=$((b + BATCH < TOTAL ? b + BATCH : TOTAL))
  echo "  $done_n/$TOTAL  ($((SECONDS - START))s)"
done

# ---- swap in the new frames only once everything succeeded -------------------------------
for f in "$WORK"/d/*.png.webp; do mv "$f" "${f%.png.webp}.webp"; done
mkdir -p "$OUT/d" "$OUT/m"
cp "$WORK"/d/*.webp "$OUT/d/"
cp "$WORK"/m/*.webp "$OUT/m/"

echo "Done: $(ls "$OUT/d" | wc -l) desktop + $(ls "$OUT/m" | wc -l) mobile frames"
du -sh "$OUT/d" "$OUT/m"
