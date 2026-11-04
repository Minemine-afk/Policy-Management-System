import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { supabase } from './lib/supabase'
import { ROLE_LABEL } from './lib/options'
import type { Role } from './lib/types'
import Login from './pages/Login'
import RequestForm from './pages/RequestForm'
import RequestView from './pages/RequestView'
import MyRequests from './pages/MyRequests'
import ApprovalQueue from './pages/ApprovalQueue'
import Introducers from './pages/Introducers'
import KnowledgeBank from './pages/KnowledgeBank'
import Admin from './pages/Admin'
import type { ReactNode } from 'react'

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { has } = useAuth()
  if (!has(role)) return <main className="page"><div className="card">You need the {ROLE_LABEL[role]} role to see this page.</div></main>
  return <>{children}</>
}

export default function App() {
  const { session, profile, loading, has } = useAuth()

  if (loading) return <div className="empty">Loading…</div>
  if (!session) return <Login />

  if (!profile || !profile.active || profile.roles.length === 0) {
    return (
      <div className="login">
        <div className="card">
          <h1>Waiting for access</h1>
          <p className="muted">
            {profile && !profile.active
              ? 'Your account has been deactivated. Contact an admin.'
              : 'You are signed in, but an admin has not given you a role yet.'}
          </p>
          <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    )
  }

  const home = has('submitter') ? '/requests/new' : has('approver') ? '/queue' : has('admin') ? '/admin' : '/knowledge'
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')

  return (
    <>
      <header className="topbar">
        <div className="brand">Distribution Management</div>
        <nav aria-label="Main">
          {has('submitter') && <NavLink to="/requests/new" className={cls}>New request</NavLink>}
          {has('submitter') && <NavLink to="/requests" end className={cls}>My requests</NavLink>}
          {has('approver') && <NavLink to="/queue" className={cls}>Approval queue</NavLink>}
          <NavLink to="/introducers" className={cls}>Introducers</NavLink>
          <NavLink to="/knowledge" className={cls}>Knowledge bank</NavLink>
          {has('admin') && <NavLink to="/admin" className={cls}>Admin</NavLink>}
        </nav>
        <div className="who">
          <span>{profile.full_name || profile.email} · {profile.roles.map((r) => ROLE_LABEL[r]).join(', ')}</span>
          <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Navigate to={home} replace />} />
        <Route path="/requests/new" element={<RequireRole role="submitter"><RequestForm /></RequireRole>} />
        <Route path="/requests/:id/edit" element={<RequireRole role="submitter"><RequestForm /></RequireRole>} />
        <Route path="/requests/:id" element={<RequestView />} />
        <Route path="/requests" element={<RequireRole role="submitter"><MyRequests /></RequireRole>} />
        <Route path="/queue" element={<RequireRole role="approver"><ApprovalQueue /></RequireRole>} />
        <Route path="/queue/:id" element={<RequireRole role="approver"><ApprovalQueue /></RequireRole>} />
        <Route path="/introducers" element={<Introducers />} />
        <Route path="/knowledge" element={<KnowledgeBank />} />
        <Route path="/admin/*" element={<RequireRole role="admin"><Admin /></RequireRole>} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </>
  )
}
