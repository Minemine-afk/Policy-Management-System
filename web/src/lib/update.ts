// After a new version of the app goes live, a page opened before it still asks for the old version's files when it
// first needs a part it had not loaded yet (the AI helper, the PDF or Excel tools). Those files are gone, so the
// browser reports "Failed to fetch dynamically imported module". That is not a fault in the browser: the page only
// needs reloading. This tells that case apart, so the app can say so (components/UpdateNotice.tsx).

/** True for the error a browser gives when a part of an older version of the app can no longer be fetched. */
export function isStaleApp(e: unknown): boolean {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|is not a valid JavaScript MIME type/i.test(m)
}

export const STALE_EVENT = 'app:stale'
export const STALE_TEXT = 'This page is from before the latest update of the app. Reload the page, then try again.'

/** Tells the app that this page is from an older version (shows the reload notice). */
export function reportStale() { window.dispatchEvent(new Event(STALE_EVENT)) }

/** The message to show for an error: the reload hint for an out-of-date page, else `fallback(e)`. */
export function sayError(e: unknown, fallback: (e: Error) => string): string {
  if (isStaleApp(e)) { reportStale(); return STALE_TEXT }
  return fallback(e instanceof Error ? e : new Error(String(e)))
}
