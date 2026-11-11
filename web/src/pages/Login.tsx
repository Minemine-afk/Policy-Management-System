import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { says } from '../lib/options'

const SAMPLE = [
  ['introducer1@example.com', 'Introducer Sam'],
  ['introducer2@example.com', 'Introducer Dana'],
  ['ops1@example.com', 'Ops Olivia'],
  ['ops2@example.com', 'Ops Omar'],
  ['bsd@example.com', 'BSD Pat'],
  ['admin@example.com', 'Admin Alex'],
]

// Sample-login shortcuts only appear against a local Supabase, never a hosted project.
const LOCAL = /127\.0\.0\.1|localhost/.test(import.meta.env.VITE_SUPABASE_URL ?? '')

export default function Login() {
  const [email, setEmail] = useState(LOCAL ? 'introducer1@example.com' : '')
  const [password, setPassword] = useState(LOCAL ? 'password123' : '')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setInfo('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(says(error.message))
    setBusy(false)
  }

  async function forgot() {
    setError(''); setInfo('')
    if (!email) { setError('Enter your email first'); return }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
    if (error) setError(says(error.message)); else setInfo('If that email has an account, a reset link is on its way.')
  }

  return (
    <div className="login">
      <div className="card">
        <div>
          <p className="eyebrow">PI Request Tracker</p>
          <h1>Sign in</h1>
        </div>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="field">Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
          <label className="field">Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          {info && <div className="small muted" role="status">{info}</div>}
          <button className="btn primary" disabled={busy}>Sign in</button>
          <button type="button" className="linkbtn" onClick={forgot}>Forgot your password?</button>
        </form>
        {LOCAL && (
          <div className="small muted">
            <p style={{ margin: '0 0 6px' }}>Prototype sample logins (password <code>password123</code>):</p>
            <div className="chips">
              {SAMPLE.map(([e, label]) => (
                <button key={e} type="button" className="chip" style={{ border: 0, cursor: 'pointer' }}
                  onClick={() => { setEmail(e); setPassword('password123') }}>{label}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
