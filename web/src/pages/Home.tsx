import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { MODULE_HOME, useModules } from '../lib/modules'

/** Home tiles: one per module this user can open. Live modules open; planned ones show as coming soon. */
export default function Home() {
  const { modules } = useAuth()
  const all = useModules()
  const mine = all.filter((m) => modules.includes(m.key))
  return (
    <main className="page">
      <h1>Home</h1>
      {mine.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>You don't have access to any modules yet. Ask an admin to switch one on for you.</p>
        </div>
      ) : (
        <div className="tiles">
          {mine.map((m) => m.live && MODULE_HOME[m.key] ? (
            <Link key={m.key} to={MODULE_HOME[m.key]!} className="queue-item tile">
              <strong>{m.name}</strong>
              <span className="small muted">{m.description}</span>
            </Link>
          ) : (
            <div key={m.key} className="queue-item tile disabled" aria-disabled="true">
              <strong>{m.name}</strong>
              <span className="small">{m.description}</span>
              <span className="chip">Coming soon</span>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
