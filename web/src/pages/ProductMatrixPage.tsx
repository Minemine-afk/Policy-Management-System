// The Product Comparison Matrix module: the same finder and side-by-side table as the "Compare products" pop-up on
// the PI request form, as its own page, with "Add to PI request" to put the chosen products on a request by its PI
// number. Who may change which request is decided in the database (add_products_to_request).
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { says } from '../lib/options'
import { loadKb, productLabel, type Kb, type KbProduct } from '../lib/kb'
import ProductMatrix from '../components/ProductMatrix'

interface Target { id: string; ref: string; status: string; insurer: string | null; plan_name: string | null; compare_term: boolean | null }

const STATUS: Record<string, string> = { submitted: 'Submitted', assigned: 'Assigned', in_progress: 'In progress', sent_back: 'Sent back' }

export default function ProductMatrixPage() {
  const [kb, setKb] = useState<Kb | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { loadKb().then(setKb).catch((e) => setError(String(e?.message ?? e))) }, [])
  return (
    <main className="page">
      <div>
        <p className="muted small" style={{ margin: 0 }}>Product Comparison Matrix</p>
        <h2 style={{ fontSize: 22, margin: 0 }}>Compare term products</h2>
        <p className="small muted" style={{ margin: '4px 0 0' }}>Factual comparison of checked Knowledge Bank products. Add the ones you pick to a PI request by its PI number.</p>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {!kb ? <div className="empty">Loading…</div> : !kb.products.length ? <div className="card">No checked products in the Knowledge Bank yet.</div> : (
        <ProductMatrix kb={kb} standalone mainId={null} selected={[]}
          initial={{ profile: 'Family', age: 35, residency: 'Singapore citizen', currency: 'SGD', mode: 'coverage', amount: 500_000,
            insurer: 'All', category: 'All', jurisdiction: 'All', gender: 'Male', smoker: false, ci: false }}
          footer={(products) => <AddToRequest products={products} />} />
      )}
    </main>
  )
}

function AddToRequest({ products }: { products: KbProduct[] }) {
  const { can } = useAuth()
  const [params] = useSearchParams()
  const [targets, setTargets] = useState<Target[] | null>(null)
  const [ref, setRef] = useState(params.get('ref') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ id: string; ref: string } | null>(null)
  const pi = can('pi_requests')
  useEffect(() => {
    if (!pi) { setTargets([]); return }
    supabase.rpc('requests_for_products').then(({ data }) => setTargets((data as Target[]) ?? []))
  }, [pi])

  const want = ref.trim().toUpperCase()
  const target = targets?.find((t) => t.ref.toUpperCase() === want)
  const now = target && [target.insurer && target.plan_name ? `${target.insurer} · ${target.plan_name}` : target.plan_name].filter(Boolean).join('')

  async function add() {
    setError(''); setDone(null)
    if (!want) { setError('Enter the PI number, e.g. PI-00012'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('add_products_to_request', { p_ref: want, p_ids: products.map((p) => p.id) })
    setBusy(false)
    if (error) { setError(says(error.message)); return }
    setDone({ id: data as string, ref: target?.ref ?? want })
    supabase.rpc('requests_for_products').then(({ data }) => setTargets((data as Target[]) ?? []))
  }

  if (!pi) return <p className="small muted" style={{ margin: 0 }}>To add these products to a PI request you need the PI Requests module. Ask an admin.</p>
  return (
    <div className="card" style={{ background: 'var(--panel-2, transparent)' }} aria-label="Add to PI request">
      <h3 className="eyebrow" style={{ margin: 0 }}>Add to PI request</h3>
      <p className="small muted" style={{ margin: 0 }}>
        The {products.length} products become the request's product (9) and the products to compare (12{products.length > 2 ? ' and 13' : ''}), in the order shown above.
        They replace what the request had.
      </p>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '0 1 260px' }}>PI number
          <input type="text" list="pm-targets" placeholder="PI-00012" value={ref} onChange={(e) => { setRef(e.target.value); setDone(null); setError('') }} />
          <datalist id="pm-targets">{(targets ?? []).map((t) => <option key={t.id} value={t.ref}>{STATUS[t.status] ?? t.status}{t.plan_name ? ` · ${t.insurer ?? ''} ${t.plan_name}` : ''}</option>)}</datalist>
        </label>
        <button type="button" className="btn primary" onClick={add} disabled={busy || !products.length}>{busy ? 'Adding…' : `Add these ${products.length} products to the PI request`}</button>
      </div>
      {target && !done && <p className="small" style={{ margin: 0 }}>{target.ref} ({STATUS[target.status] ?? target.status}) now has: {now || 'no product chosen'}. After adding: {products.map(productLabel).join(', ')}.</p>}
      {targets && !targets.length && <p className="small muted" style={{ margin: 0 }}>You have no open PI requests you can change right now.</p>}
      {done && <div className="notice ok" role="status">Added to {done.ref}. <Link to={`/requests/${done.id}`}>Open {done.ref}</Link></div>}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  )
}
