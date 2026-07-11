#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT_DIR/public/pets/register/shiba.jpg"
RES="$ROOT_DIR/android/app/src/main/res"

command -v convert >/dev/null || { echo "ImageMagick convert is required" >&2; exit 1; }
command -v identify >/dev/null || { echo "ImageMagick identify is required" >&2; exit 1; }
test -f "$SOURCE" || { echo "Missing source image: $SOURCE" >&2; exit 1; }

for spec in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  density="${spec%%:*}"
  size="${spec##*:}"
  convert "$SOURCE" -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" "$RES/mipmap-${density}/ic_launcher.png"
  convert "$SOURCE" -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" "$RES/mipmap-${density}/ic_launcher_round.png"
done

for spec in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  density="${spec%%:*}"
  size="${spec##*:}"
  foreground_size=$((size * 72 / 100))
  convert -size "${size}x${size}" xc:none \
    \( "$SOURCE" -resize "${foreground_size}x${foreground_size}" \) \
    -gravity center -composite "$RES/mipmap-${density}/ic_launcher_foreground.png"
done

while IFS= read -r file; do
  dimensions="$(identify -format '%wx%h' "$file")"
  width="${dimensions%x*}"
  height="${dimensions#*x}"
  if (( width < height )); then min_side=$width; else min_side=$height; fi
  image_side=$((min_side * 42 / 100))
  convert -size "$dimensions" xc:'#fffdf7' \
    \( "$SOURCE" -resize "${image_side}x${image_side}" \) \
    -gravity center -composite "$file"
done < <(find "$RES" -path '*/splash.png' -type f | sort)

echo "Android launcher and splash assets regenerated from $SOURCE"
