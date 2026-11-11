/** One CSV cell. Text that a spreadsheet would run as a formula (= + - @) gets a leading quote mark. */
function cell(v: unknown) {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: unknown[][]) {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n')
}

/** Saves rows as a CSV file that Excel opens with the right characters (UTF-8 with BOM). */
export function downloadCsv(name: string, rows: unknown[][]) {
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/**
 * Reads CSV text (as saved by Excel or by downloadCsv) into rows of cells. Handles quoted cells with commas,
 * quotes and line breaks, a UTF-8 BOM, and the leading quote mark downloadCsv adds before = + - @.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const endCell = () => { row.push(/^'[=+\-@]/.test(cur) ? cur.slice(1) : cur); cur = '' }
  for (; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else quoted = false }
      else cur += c
    } else if (c === '"' && cur === '') quoted = true
    else if (c === ',') endCell()
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endCell(); rows.push(row); row = []
    } else cur += c
  }
  if (cur !== '' || row.length) { endCell(); rows.push(row) }
  // Drop rows that are completely empty (blank lines, trailing commas from Excel).
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}
