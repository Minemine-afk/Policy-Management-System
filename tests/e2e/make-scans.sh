#!/bin/bash
# Makes "scanned" copies (pictures only, no text inside) of the two real Singapore sample PIs, to test OCR.
# Usage: ./make-scans.sh /path/to/pi-samples /path/to/output [tilt in degrees, default 0.3]   (needs pdftoppm and Python with Pillow)
set -euo pipefail
SRC=$1; OUT=$2; TILT=${3:-0.3}; mkdir -p "$OUT"; TMP=$(mktemp -d)
for n in SG_Singlife_EliteTermII_2024 SG_TokioMarine-CIMB_TermProtectPlus_2022; do
  pdftoppm -r 200 -gray -png "$SRC/$n.pdf" "$TMP/p_$n"
  python3 - "$TMP" "$n" "$OUT" "$TILT" <<'PY'
import glob, sys
from PIL import Image
tmp, n, out, tilt = sys.argv[1:]
ims = [Image.open(f).convert('L').rotate(float(tilt), fillcolor=255).convert('RGB') for f in sorted(glob.glob(f'{tmp}/p_{n}-*.png'))]
ims[0].save(f'{out}/SCAN_{n}.pdf', save_all=True, append_images=ims[1:], resolution=200)
PY
done
echo "Scanned copies written to $OUT"
