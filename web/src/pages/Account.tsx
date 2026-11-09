import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

/** Change your own password (for example the temporary one bsd gave you, or after a reset email). */
export default function Account() {
  const { profile, recovering, clearRecovering } = useAuth()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setMsg(''); setError('')
    if (pw.length < 8) return setError('Use at least 8 characters.')
    if (pw !== pw2) return setError('The two passwords do not match.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) return setError(error.message)
    setPw(''); setPw2(''); clearRecovering()
    setMsg('Password changed. Use it next time you sign in.')
  }

  return (
    <main className="page">
      <h1>Account</h1>
      <form className="card" onSubmit={save} aria-label="Change password" style={{ maxWidth: 480 }}>
        <p className="small muted" style={{ margin: 0 }}>
          {recovering ? 'Choose a new password to finish resetting it.' : `Signed in as ${profile?.email ?? ''}.`}
        </p>
        <label className="field">New password
          <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        <label className="field">Repeat new password
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        {msg && <div className="small" role="status" style={{ color: 'var(--ok)' }}>{msg}</div>}
        <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button></div>
      </form>
    </main>
  )
}
