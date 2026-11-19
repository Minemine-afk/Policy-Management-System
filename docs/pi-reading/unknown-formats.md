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

## Teach a new insurer (piTeach.ts)

When ops or BSD save a PI pack, the browser looks at each value they typed or corrected (and each general-rules guess
they kept) and finds where it sits in that PI: the words just before it on the line (`beside`, with how many columns
after), or the column heading above it (`under`). A monthly figure that ops turned into a yearly one is kept with its
factor (x 12, 4 or 2). A place is kept only if, read back on the same PI, it gives exactly that value. The places go to
the `insurer_label_rules` table (`supabase/cloud/1m-upgrade.sql`), per insurer and plan.

What is stored: insurer, plan (policy name), field, label words, position, factor. Never a value. Labels that contain
the insured name or date of birth, an amount, a long number, a date, an e-mail or web address are dropped in the browser
and refused by the database.

Reading: the insurer is the one the reader found, or one whose name is written in the PI (labels alone never pick an
insurer). Learned values fill blanks and replace general-rules guesses, never layout-rule values, and are tagged
"Learned". When places disagree the cell stays blank. A place found only once counts only on a PI of the same plan; for
another plan of that insurer two places must agree.

Measured (`node tests/pi-extract/check-teach.mjs <pi-samples> --max-wrong 0`, 14 overseas PIs, 20 Nov 2026):
- same insurer, new client (copy of each PI with every taught amount changed and the name replaced): 75/93 right before
  teaching, 86/93 after, 0 wrong. Blanks left: titles with no label (policy names), prose (iA insurer), a date of birth.
- same insurer, another product (Zurich x2, Hong Leong x2, Manulife Canada/Malaysia): 36/39 before and after, 0 wrong
  (before the two-places rule this added 2 wrong values; that is why it exists).
- other insurers' places on each PI: 0 values changed. Client values kept in a place: 0.

BSD (top bar "PI reader") and admin (Admin > PI reader) see what was learned per insurer and delete places.
