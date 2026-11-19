# Reading PIs in layouts the reader doesn't know

The PI comparison reader (`web/src/lib/piExtract.ts`) has rules for the layouts we have seen (LIA summary table,
Singlife, Tokio Marine, FWD, HSBC). For anything else, the general rules in `web/src/lib/piGeneric.ts` fill the
cells the layout rules left blank. Their values are marked `guess` and shown on screen with a blue cell and a
**Check** tag. Rule of the house: a blank cell is better than a wrong one, so when readings disagree, the cell
stays blank with a note.

## Tests

All run in Node 22.18+ after `npm ci` in `web/`, against the sample PIs in the project files (`pi-samples/`).

| Script | What it checks | Result (2026-11-12) |
| --- | --- | --- |
| `check.mjs <dir> expected-sg-samples.json` | The 4 Singapore PIs with layout rules | 96/96 |
| `variants.mjs <dir> expected-sg-samples.json` | Same PIs with reworded labels, and with the riders heading renamed or removed (blank allowed there, never a wrong value) | 23/23 |
| `check-unknown.mjs <dir> expected-unknown-formats.json` | 14 Canada / US / Malaysia PIs the reader has no rules for: right, blank, **wrong** per field | 87/107 right, 0 wrong (was 18/107, 1 wrong) |
| `check-unknown.mjs <dir> expected-sg-samples.json --general-only` | The general rules alone on the SG PIs, as if their layouts were new | 18/92 right, 0 wrong |
| `check-ocr.mjs <dir of scans> expected-sg-samples.json` | Scanned PIs through the in-browser OCR | 150 dpi, 1.5° tilt, blur: 0 wrong (was 3 wrong) |

`check-unknown.mjs --max-wrong 0` exits non-zero when any value is wrong, for use before merging reader changes.

## Adding a new layout

1. Ask for a dummy-client PI from that insurer and add it to `pi-samples/`.
2. Run `check-unknown.mjs` with an expected entry for it first: that measures the general rules on a truly unseen layout.
3. Only then add layout rules (or an `INSURER_RULES` entry), and add the PI to `expected-sg-samples.json`.
