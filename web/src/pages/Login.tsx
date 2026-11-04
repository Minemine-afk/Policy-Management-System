import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

const SAMPLE = [
  ['submitter@example.com', 'Submitter'],
  ['approver@example.com', 'Submitter + Approver'],
  ['approver2@example.com', 'Approver'],
  ['admin@example.com', 'Admin'],
  ['admin2@example.com', 'Admin + Approver'],
  ['editor@example.com', 'Content editor'],
]

export default function Login() {
  const [email, setEmail] = useState('submitter@example.com')
  const [password, setPassword] = useState('password123')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const microsoft = import.meta.env.VITE_ENABLE_MICROSOFT_LOGIN === 'true'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  async function signInMicrosoft() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: { scopes: 'email profile openid', redirectTo: window.location.origin },
    })
    if (error) setError(error.message)
  }

  return (
    <div className="login">
      <div className="card">
        <div>
          <p className="eyebrow">Distribution Management</p>
          <h1>Sign in</h1>
        </div>
        {microsoft && (
          <button className="btn primary" onClick={signInMicrosoft}>Sign in with Microsoft</button>
        )}
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="field">Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
          <label className="field">Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          <button className={microsoft ? 'btn' : 'btn primary'} disabled={busy}>Sign in</button>
        </form>
        {!microsoft && (
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
