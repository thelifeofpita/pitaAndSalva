#!/usr/bin/env bash
# Build the Pick a Side project-page loops from the source render.
#
# Source (gitignored, in update/pick_a_side/src/ after unzipping the Drive folder):
#   exp_fullres/full_halfres####.png   1920x1080 RGBA, the order kiosk
#   fries_sticker/fries_Sticker####.png 1920x1080 RGBA, the reminder carton
#   app.mov                            2160x3840 ProRes 4444 (alpha), 60fps
#
# Ranges from pick_a_side.rtf:
#   order     exp_fullres 1057-1319   menu blocks fold into a ballot
#   checkout  exp_fullres 1660-1763   order summary settles into a ballot box (1s
#                                     hold at each end before the bounce)
#   reminder  fries_sticker 30-238    carton turns to show the "I PICKED MY SIDE"
#                                     sticker (starts with it already stuck on — the
#                                     bounce through the stick-on read wrong)
#   app       app.mov 0-815           the app, cut before it zooms to the home screen
#
# EVERYTHING WAS ANIMATED AT 60 fps. We take every 2nd frame and output at
# 30 fps, so playback speed is exactly the source's while the frame count (and
# file size / encode time) stays sane. order/checkout/reminder bounce
# (ping-pong); app plays straight.
#
# Transparency is kept -> animated WebP in an <img>, the one alpha animation
# format every current browser (incl. Safari) plays. This ffmpeg build cannot
# make VP9-alpha WebM (libvpx-vp9 silently drops the alpha plane).
# It also can't DECODE animated WebP, so checks below use Pillow.
#
# Run from repo root:  tools/build_pas.sh
set -euo pipefail

SRC="update/pick_a_side/src"
OUT="img/projects/pick-a-side"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

FPS=30        # output rate
STEP=2        # source is 60 fps; every 2nd frame -> 30 fps at true speed

# ---- ping-pong loop from a numbered PNG range ----------------------------
# $1 printf-pattern  $2 first  $3 last  $4 crop  $5 outW  $6 q  $7 cl  $8 name
#   $9 hold = frames to freeze on BOTH ends before turning around (opt)
pingpong() {
  local pat=$1 a=$2 b=$3 crop=$4 w=$5 q=$6 cl=$7 name=$8 hold=${9:-0}
  local dir="$WORK/$name" i=0 n src h
  mkdir -p "$dir"
  link() { printf -v src "$PWD/$pat" "$1"; ln -sf "$src" "$(printf "%s/%05d.png" "$dir" "$i")"; i=$((i+1)); }
  # hold a, forward a..b, hold b, back to a+1 — a and b are never doubled in
  # the moving part; libwebp merges each hold into one long-duration frame
  for ((h=0; h<hold; h++)); do link "$a"; done
  for n in $(seq "$a" "$STEP" "$b"); do link "$n"; done
  for ((h=0; h<hold; h++)); do link "$b"; done
  for n in $(seq $((b-STEP)) "-$STEP" $((a+1))); do link "$n"; done
  echo "  $name: $i frames @ ${FPS}fps (hold ${hold} both ends)"
  ffmpeg -y -v error -framerate "$FPS" -i "$dir/%05d.png" \
    -vf "crop=$crop,scale=$w:-2:flags=lanczos" \
    -c:v libwebp_anim -lossless 0 -q:v "$q" -compression_level "$cl" -loop 0 -an \
    "$OUT/$name.webp"
}

echo "order.webp";    pingpong "$SRC/exp_fullres/full_halfres%04d.png" 1057 1319 "626:1030:1022:50" 560 74 6 order
echo "checkout.webp"; pingpong "$SRC/exp_fullres/full_halfres%04d.png" 1660 1763 "648:1040:240:40" 560 74 6 checkout 30
echo "reminder.webp"; pingpong "$SRC/fries_sticker/fries_Sticker%04d.png" 30 238 "760:850:590:140" 560 56 4 reminder

echo "app.webp (straight, 60->30fps, cut at ~f816 before it zooms to the home screen)"
ffmpeg -y -v error -t 13.6 -i "$SRC/app.mov" \
  -vf "crop=1680:3614:240:114,fps=$FPS,scale=460:-2:flags=lanczos" \
  -c:v libwebp_anim -lossless 0 -q:v 62 -compression_level 5 -loop 0 -an \
  "$OUT/app.webp"

# ---- first-frame stills (poster / reveal-crush target) ------------------
still() { ffmpeg -y -v error -i "$1" -frames:v 1 -vf "$2" "$OUT/$3"; }
still "$SRC/exp_fullres/full_halfres1057.png"    "crop=626:1030:1022:50,scale=560:-2" order.png
still "$SRC/exp_fullres/full_halfres1660.png"    "crop=648:1040:240:40,scale=560:-2"  checkout.png
still "$SRC/fries_sticker/fries_Sticker0120.png" "crop=760:850:590:140,scale=560:-2"  reminder.png
ffmpeg -y -v error -i "$SRC/app.mov" -frames:v 1 -vf "crop=1680:3614:240:114,scale=460:-2" "$OUT/app.png"

ls -la "$OUT"
python3 - <<'PY'
import os
from PIL import Image
d="img/projects/pick-a-side"
for f in sorted(os.listdir(d)):
    if f.endswith(".webp"):
        im=Image.open(d+"/"+f)
        print(f, im.size, getattr(im,"n_frames","?"),"frames",
              round(os.path.getsize(d+"/"+f)/1e6,2),"MB")
PY
