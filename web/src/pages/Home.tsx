import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { dueInfo, introGroup } from '../lib/options'
import { useSettings } from '../lib/settings'
import { MODULE_HOME, useModules, type ModuleKey } from '../lib/modules'

/** Simple stroke icons, one per module and admin tool. */
const ICON: Record<string, ReactNode> = {
  pi_requests: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>,
  product_matrix: <><rect x="3" y="4" width="7" height="16" rx="1" /><rect x="14" y="4" width="7" height="16" rx="1" /></>,
  introducer_intelligence: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></>,
  knowledge_hub: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></>,
  content_studio: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  linkedin_outreach: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 11l2 2 4-4" /></>,
  access: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  settings: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  audit: <><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 12h6M9 16h4" /></>,
}
const Icon = ({ k }: { k: string }) => (
  <span className="tile-icon" aria-hidden="true">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ICON[k]}</svg>
  </span>
)

type Badge = { text: string; tone: 'info' | 'warn' | 'bad' }

/** Short counts on the PI Requests tile. Introducers never see urgency or deadlines (the database hides them anyway). */
function usePiBadges(on: boolean, introducer: boolean, soonHours: number): Badge[] {
  const [badges, setBadges] = useState<Badge[]>([])
  useEffect(() => {
    if (!on) return
    let live = true
    supabase.from('request_list').select('status, assignee_id, due_at, paused_at').then(({ data }) => {
      if (!live || !data) return
      const out: Badge[] = []
      if (introducer) {
        const prog = data.filter((r) => introGroup(r.status) === 'in_progress').length
        const back = data.filter((r) => r.status === 'sent_back').length
        if (prog) out.push({ text: `${prog} in progress`, tone: 'info' })
        if (back) out.push({ text: `${back} sent back to you`, tone: 'warn' })
      } else {
        const pool = data.filter((r) => r.status === 'submitted' && !r.assignee_id).length
        const late = data.filter((r) => dueInfo(r, soonHours)?.overdue).length
        if (pool) out.push({ text: `${pool} unassigned`, tone: 'info' })
        if (late) out.push({ text: `${late} overdue`, tone: 'bad' })
      }
      setBadges(out)
    })
    return () => { live = false }
  }, [on, introducer, soonHours])
  return badges
}

function Tile({ to, icon, name, description, badges = [], soon }: {
  to?: string; icon: string; name: string; description: string; badges?: Badge[]; soon?: boolean
}) {
  const body = (
    <>
      <Icon k={icon} />
      <strong className="tile-name">{name}</strong>
      <span className="small muted">{description}</span>
      {(soon || badges.length > 0) && (
        <span className="tile-badges">
          {soon ? <span className="pill grey">Coming soon</span> : badges.map((b) => <span key={b.text} className={`pill ${b.tone}`}>{b.text}</span>)}
        </span>
      )}
    </>
  )
  return to
    ? <Link to={to} className="queue-item tile">{body}</Link>
    : <div className="queue-item tile disabled" aria-disabled="true">{body}</div>
}

/** The first page after login: one tile per module this user can open. Live modules open; planned ones say coming soon.
 *  Admins get their admin tools instead (they do not work on requests). */
export default function Home() {
  const { profile, modules, has } = useAuth()
  const settings = useSettings()
  const all = useModules()
  const admin = has('admin')
  const intro = has('introducer')
  const mine = all.filter((m) => modules.includes(m.key))
  const badges = usePiBadges(!admin && modules.includes('pi_requests'), intro, settings.due_soon_hours)
  const first = (profile?.full_name || '').trim().split(/\s+/)[0]
  const hour = new Date().getHours()
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <main className="page">
      <div>
        <h1 style={{ margin: 0 }}>{hello}{first ? `, ${first}` : ''}</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          {admin ? 'Admin tools. Admins manage the system and do not see requests or client details.'
            : 'Choose where you want to work. You only see the modules your admin has given you.'}
        </p>
      </div>

      {admin ? (
        <nav className="tiles" aria-label="Admin tools">
          <Tile to="/admin/users" icon="users" name="Users and roles" description="Add people, set roles, import or export users." />
          <Tile to="/admin/access" icon="access" name="Module access" description="Switch modules on or off for each role or person." />
          <Tile to="/admin/settings" icon="settings" name="Deadline settings" description="Request deadline and due-soon warning." />
          <Tile to="/admin/audit" icon="audit" name="Audit log" description="Who did what and when, with filters." />
        </nav>
      ) : mine.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>You don't have access to any modules yet. Ask an admin to switch one on for you.</p>
        </div>
      ) : (
        <nav className="tiles" aria-label="Modules">
          {mine.map((m) => {
            const to = m.live ? MODULE_HOME[m.key as ModuleKey] : undefined
            return <Tile key={m.key} to={to} icon={m.key} name={m.name} description={m.description}
              badges={m.key === 'pi_requests' ? badges : []} soon={!to} />
          })}
        </nav>
      )}

      <p className="small muted" style={{ margin: 0 }}>
        {admin ? 'If an admin also needs to work on requests, give them a separate login with that role (one role per login).'
          : "Need a module that isn't here? Ask your admin to switch it on for you."}
      </p>
    </main>
  )
}
