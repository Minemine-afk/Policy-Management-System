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
