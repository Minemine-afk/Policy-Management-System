import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import RequestForm from './pages/RequestForm'
import RequestView from './pages/RequestView'
import Board from './pages/Board'
import Backlog from './pages/Backlog'
import Admin from './pages/Admin'
import Notifications from './pages/Notifications'
import Account from './pages/Account'
import Home from './pages/Home'
import LearnedPlaces from './components/LearnedPlaces'
import { KbDocuments, KbProducts } from './pages/KnowledgeHub'
import KbProduct from './pages/KbProduct'
import ProductMatrixPage from './pages/ProductMatrixPage'
import { useUnreadCount } from './lib/notifications'
import TopBar, { type NavItem } from './components/TopBar'

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

  // Admin manages users, settings and the audit log; it does not work on requests.
  const admin = has('admin')
  // Modules: the admin switches them per user. Inside a module the role decides what the user sees.
  const pi = !admin && can('pi_requests')
  // Knowledge Hub: ops and bsd keep the Knowledge Bank; introducers given the module read checked documents.
  const kb = !admin && can('knowledge_hub')
  const kbStaff = kb && (has('ops') || has('bsd'))
  // Product Comparison Matrix: the compare pop-up as a page, with "Add to PI request".
  const matrix = !admin && can('product_matrix')
  // Everyone starts on the module picker (Modules), even with only one module.
  const home = '/home'
  const introducer = has('introducer')
  const items: NavItem[] = [
    { to: '/home', label: 'Modules' },
    ...(pi && introducer ? [{ to: '/requests/new', label: 'New request' }] : []),
    ...(pi ? [{ to: '/board', label: 'Board' }] : []),
    ...(pi ? [{ to: '/backlog', label: introducer ? 'My requests' : 'Backlog' }] : []),
    ...(pi && has('bsd') ? [{ to: '/reader', label: 'PI reader' }] : []),
    ...(matrix ? [{ to: '/matrix', label: 'Compare products' }] : []),
    ...(kb ? [{ to: '/kb', label: 'Knowledge Hub' }] : []),
    ...(admin ? [{ to: '/admin', label: 'Admin' }] : []),
  ]
  return (
    <>
      <TopBar items={items} profile={profile} unread={unread} />
      <Routes>
        <Route path="/" element={<Navigate to={home} replace />} />
        <Route path="/home" element={<Home />} />
        <Route path="/board" element={pi ? <Board /> : <Navigate to={home} replace />} />
        <Route path="/backlog" element={pi ? <Backlog /> : <Navigate to={home} replace />} />
        <Route path="/requests/new" element={pi && has('introducer') ? <RequestForm /> : <Navigate to={home} replace />} />
        <Route path="/requests/:id/edit" element={pi && has('introducer') ? <RequestForm /> : <Navigate to={home} replace />} />
        <Route path="/requests/:id" element={pi ? <RequestView /> : <Navigate to={home} replace />} />
        <Route path="/compare" element={<CompareMoved />} />
        <Route path="/reader" element={pi && has('bsd') ? <main className="page"><LearnedPlaces /></main> : <Navigate to={home} replace />} />
        <Route path="/matrix" element={matrix ? <ProductMatrixPage /> : <Navigate to={home} replace />} />
        <Route path="/kb" element={kb ? <KbDocuments /> : <Navigate to={home} replace />} />
        <Route path="/kb/products" element={kbStaff ? <KbProducts /> : <Navigate to={home} replace />} />
        <Route path="/kb/products/new" element={kbStaff ? <KbProduct /> : <Navigate to={home} replace />} />
        <Route path="/kb/products/:id" element={kbStaff ? <KbProduct /> : <Navigate to={home} replace />} />
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
