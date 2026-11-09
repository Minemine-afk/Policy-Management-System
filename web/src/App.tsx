import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { supabase } from './lib/supabase'
import { ROLE_LABEL } from './lib/options'
import Login from './pages/Login'
import RequestForm from './pages/RequestForm'
import RequestView from './pages/RequestView'
import Board from './pages/Board'
import Backlog from './pages/Backlog'
import Admin from './pages/Admin'
import Compare from './pages/Compare'
import Notifications from './pages/Notifications'
import Account from './pages/Account'
import { useUnreadCount } from './lib/notifications'

export default function App() {
  const { session, profile, loading, has, recovering } = useAuth()
  const unread = useUnreadCount()

  if (loading) return <div className="empty">Loading…</div>
  if (!session) return <Login />

  if (recovering) return <Account />

  if (!profile || !profile.active || !profile.role) {
    return (
      <div className="login">
        <div className="card">
          <h1>Waiting for access</h1>
          <p className="muted">
            {profile && !profile.active
              ? 'Your account has been deactivated. Contact bsd.'
              : 'You are signed in, but bsd has not given you a role yet.'}
          </p>
          <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    )
  }

  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  return (
    <>
      <header className="topbar">
        <div className="brand">PI Request Tracker</div>
        <nav aria-label="Main">
          {has('introducer') && <NavLink to="/requests/new" className={cls}>New request</NavLink>}
          <NavLink to="/board" className={cls}>Board</NavLink>
          <NavLink to="/backlog" className={cls}>{has('introducer') ? 'My requests' : 'Backlog'}</NavLink>
          {has('ops') && <NavLink to="/compare" className={cls}>Compare PIs</NavLink>}
          {has('bsd') && <NavLink to="/admin" className={cls}>Admin</NavLink>}
        </nav>
        <div className="who">
          <NavLink to="/notifications" className={({ isActive }) => `bell${isActive ? ' active' : ''}`} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
            <span aria-hidden="true">🔔</span>{unread > 0 && <span className="badge">{unread}</span>}
          </NavLink>
          <span>{profile.full_name || profile.email} · {ROLE_LABEL[profile.role]}</span>
          <NavLink to="/account" className="acct" title="Change your password">Account</NavLink>
          <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Navigate to="/board" replace />} />
        <Route path="/board" element={<Board />} />
        <Route path="/backlog" element={<Backlog />} />
        <Route path="/requests/new" element={has('introducer') ? <RequestForm /> : <Navigate to="/board" replace />} />
        <Route path="/requests/:id/edit" element={has('introducer') ? <RequestForm /> : <Navigate to="/board" replace />} />
        <Route path="/requests/:id" element={<RequestView />} />
        <Route path="/compare" element={has('ops') ? <Compare /> : <Navigate to="/board" replace />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/account" element={<Account />} />
        <Route path="/admin/*" element={has('bsd') ? <Admin /> : <Navigate to="/board" replace />} />
        <Route path="*" element={<Navigate to="/board" replace />} />
      </Routes>
    </>
  )
}
