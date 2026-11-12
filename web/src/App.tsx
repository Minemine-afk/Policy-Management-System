import { Navigate, NavLink, Route, Routes, useSearchParams } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { supabase } from './lib/supabase'
import { ROLE_LABEL } from './lib/options'
import Login from './pages/Login'
import RequestForm from './pages/RequestForm'
import RequestView from './pages/RequestView'
import Board from './pages/Board'
import Backlog from './pages/Backlog'
import Admin from './pages/Admin'
import Notifications from './pages/Notifications'
import Account from './pages/Account'
import Home from './pages/Home'
import { useUnreadCount } from './lib/notifications'

export default function App() {
  const { session, profile, loading, has, can, recovering } = useAuth()
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
              ? 'Your account has been deactivated. Contact an admin.'
              : 'You are signed in, but an admin has not given you a role yet.'}
          </p>
          <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    )
  }

  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  // Admin manages users, settings and the audit log; it does not work on requests.
  const admin = has('admin')
  // Modules: the admin switches them per user. Inside a module the role decides what the user sees.
  const pi = !admin && can('pi_requests')
  // Everyone starts on the module picker (Modules), even with only one module.
  const home = '/home'
  return (
    <>
      <header className="topbar">
        <div className="brand">PWS Service Hub</div>
        <nav aria-label="Main">
          <NavLink to="/home" className={cls}>Modules</NavLink>
          {pi && has('introducer') && <NavLink to="/requests/new" className={cls}>New request</NavLink>}
          {pi && <NavLink to="/board" className={cls}>Board</NavLink>}
          {pi && <NavLink to="/backlog" className={cls}>{has('introducer') ? 'My requests' : 'Backlog'}</NavLink>}
          {admin && <NavLink to="/admin" className={cls}>Admin</NavLink>}
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
        <Route path="/" element={<Navigate to={home} replace />} />
        <Route path="/home" element={<Home />} />
        <Route path="/board" element={pi ? <Board /> : <Navigate to={home} replace />} />
        <Route path="/backlog" element={pi ? <Backlog /> : <Navigate to={home} replace />} />
        <Route path="/requests/new" element={pi && has('introducer') ? <RequestForm /> : <Navigate to={home} replace />} />
        <Route path="/requests/:id/edit" element={pi && has('introducer') ? <RequestForm /> : <Navigate to={home} replace />} />
        <Route path="/requests/:id" element={pi ? <RequestView /> : <Navigate to={home} replace />} />
        <Route path="/compare" element={<CompareMoved />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/account" element={<Account />} />
        <Route path="/admin/*" element={admin ? <Admin /> : <Navigate to={home} replace />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </>
  )
}

/** Compare PIs now lives on each request page; old links still land in the right place. */
function CompareMoved() {
  const [params] = useSearchParams()
  const id = params.get('request')
  return <Navigate to={id ? `/requests/${id}` : '/board'} replace />
}
