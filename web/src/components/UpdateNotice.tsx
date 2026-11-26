import { useEffect, useState } from 'react'
import { STALE_EVENT, isStaleApp } from '../lib/update'

/** A bar at the bottom of the screen when this page is from before the app's latest update (see lib/update.ts):
 *  it says to reload, with a button, instead of leaving a technical error. */
export default function UpdateNotice() {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const on = () => setStale(true)
    const rejected = (e: PromiseRejectionEvent) => { if (isStaleApp(e.reason)) setStale(true) }
    // Vite's own signal that a part of the app could not be fetched.
    window.addEventListener('vite:preloadError', on)
    window.addEventListener(STALE_EVENT, on)
    window.addEventListener('unhandledrejection', rejected)
    return () => {
      window.removeEventListener('vite:preloadError', on)
      window.removeEventListener(STALE_EVENT, on)
      window.removeEventListener('unhandledrejection', rejected)
    }
  }, [])
  if (!stale) return null
  return (
    <div className="update-notice" role="alert">
      <span><strong>The app was updated.</strong> This page is from before the update, so some parts of it no longer work. Reload it to carry on. Anything typed here but not saved yet will be cleared, so note it down first.</span>
      <button className="btn" onClick={() => window.location.reload()}>Reload the page</button>
    </div>
  )
}
