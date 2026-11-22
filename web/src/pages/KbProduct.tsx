// One Knowledge Bank product record: its facts (each naming a document and page), premium rates, and the
// maker-checker steps: save draft, send for check, then a BSD person who did not make the change checks it.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { nameOf, usePeople } from '../lib/people'
import { fmtDate, fmtDateTime, says } from '../lib/options'
import { CURRENCIES, RESIDENCIES, STANDARD_INSURERS } from '../lib/formOptions'
import {
  FACT_FIELDS, RATES_HEADER, blankRecord, docLabel, docState, liveRecord, loadDocs, loadUsable, parseRates, productState, ratesToCsv,
  type Fact, type HistoryRow, type KbDoc, type KbProductRow, type ProductRecord, type Rate,
} from '../lib/kbAdmin'
import { ReasonDialog } from '../components/ui'
import { KbHeader } from './KnowledgeHub'

const FIELD_LABEL: Record<string, string> = {
  insurer: 'Insurer', name: 'Product name', category: 'Category', dpi: 'Direct Purchase Insurance', jurisdiction: 'Onshore / offshore',
  currencies: 'Policy currencies', entry_age_min: 'Entry age from', entry_age_max: 'Entry age to', residency: 'Who can apply',
  sa_min: 'Minimum sum assured', sa_max: 'Maximum sum assured', has_tpd: 'TPD cover', has_ci: 'Critical illness cover',
}
const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v == null || v === '' ? '—' : String(v))
const factText = (f?: Fact) => (f?.v ? `${f.v}${f.page ? ` (p.${f.page})` : ''}` : '—')

/** What the draft changes compared with the checked version, in plain words. */
function changes(live: ProductRecord | null, draft: ProductRecord, rates: boolean): string[] {
  if (!live) return ['New product record']
  const out: string[] = []
  for (const k of Object.keys(FIELD_LABEL) as (keyof ProductRecord)[]) {
    if (JSON.stringify(show(live[k])) !== JSON.stringify(show(draft[k]))) out.push(`${FIELD_LABEL[k]}: ${show(live[k])} → ${show(draft[k])}`)
  }
  for (const r of [{ key: '_ps', label: 'Product Summary' }, { key: '_rs', label: 'Rate sheet' }, ...FACT_FIELDS]) {
    const a = live.facts[r.key], b = draft.facts[r.key]
    if ((a?.v ?? '') !== (b?.v ?? '') || (a?.page ?? null) !== (b?.page ?? null) || (a?.doc ?? '') !== (b?.doc ?? '')) {
      out.push(r.key.startsWith('_') ? `${r.label}: source document changed` : `${r.label}: ${factText(a)} → ${factText(b)}${(a?.doc ?? '') !== (b?.doc ?? '') && a?.doc && b?.doc ? ' (new source document)' : ''}`)
    }
  }
  if (rates) out.push('Premium rates replaced')
  return out
}

export default function KbProduct() {
  const { id } = useParams()
  const isNew = !id
  const nav = useNavigate()
  const { profile, has } = useAuth()
  const people = usePeople()
  const checker = has('bsd')
  const [row, setRow] = useState<KbProductRow | null>(null)
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [usable, setUsable] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [liveRates, setLiveRates] = useState<Rate[]>([])
  const [rec, setRec] = useState<ProductRecord>(blankRecord())
  const [saved, setSaved] = useState('')            // the record as last saved, to spot unsaved changes
  const [ratesText, setRatesText] = useState('')
  const [ratesTouched, setRatesTouched] = useState(false)
  const [ready, setReady] = useState(isNew)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'back' | 'withdraw' | null>(null)

  const load = useCallback(async () => {
    const [d, u] = await Promise.all([loadDocs(), loadUsable()])
    setDocs(d); setUsable(u)
    if (!id) return
    const [{ data }, h, r] = await Promise.all([
      supabase.from('kb_products').select('*').eq('id', id).maybeSingle(),
      supabase.from('kb_product_history').select('*').eq('product_id', id).order('version', { ascending: false }),
      supabase.from('kb_rates').select('age, gender, smoker, rate, ci_rate').eq('product_id', id).order('age'),
    ])
    const p = data as KbProductRow | null
    setRow(p); setHistory((h.data as HistoryRow[]) ?? [])
    const lr = ((r.data as Rate[]) ?? []).map((x) => ({ ...x, rate: Number(x.rate), ci_rate: x.ci_rate == null ? null : Number(x.ci_rate) }))
    setLiveRates(lr)
    if (p) {
      const base = p.pending ?? liveRecord(p)
      setRec({ ...base, facts: base.facts ?? {} }); setSaved(JSON.stringify({ ...base, rates: undefined }))
      setRatesText(ratesToCsv(p.pending?.rates ?? lr)); setRatesTouched(false)
    }
    setReady(true)
  }, [id])
  useEffect(() => { load() }, [load])

  const set = <K extends keyof ProductRecord>(k: K, v: ProductRecord[K]) => setRec((s) => ({ ...s, [k]: v }))
  const setFact = (key: string, patch: Partial<Fact>) => setRec((s) => ({ ...s, facts: { ...s.facts, [key]: { ...s.facts[key], ...patch } } }))
  const toggle = (k: 'currencies' | 'residency', v: string, on: boolean) => set(k, on ? [...rec[k], v] : rec[k].filter((x) => x !== v))
  const parsed = useMemo(() => parseRates(ratesText), [ratesText])
  const dirty = JSON.stringify({ ...rec, rates: undefined }) !== saved || ratesTouched
  const insurers = useMemo(() => [...new Set([...docs.map((d) => d.insurer), ...STANDARD_INSURERS])], [docs])
  // Documents to pick from: this insurer's current versions, plus any the record already names.
  const named = new Set(Object.values(rec.facts).map((f) => f?.doc).filter(Boolean))
  const docOptions = docs.filter((d) => named.has(d.id) || (!d.replaced_by && d.insurer.toLowerCase() === rec.insurer.trim().toLowerCase()))
  const ps = rec.facts._ps?.doc

  const maker = row && profile && [row.pending_by, row.submitted_by].includes(profile.id)
  const canCheck = checker && row?.pending_state === 'check' && !maker
  const live = row && row.verified_at ? liveRecord(row) : null

  async function save() {
    setError(''); setMsg('')
    if (parsed.error) { setError(parsed.error); return }
    // A fact typed without a source names the Product Summary.
    const facts: Record<string, Fact> = {}
    for (const [k, f] of Object.entries(rec.facts)) {
      if (k.startsWith('_')) { if (f?.doc) facts[k] = { doc: f.doc }; continue }
      if (!f?.v?.trim()) continue
      facts[k] = { v: f.v.trim(), doc: f.doc || ps, page: f.page ? Number(f.page) : undefined }
    }
    const keepRates = ratesTouched ? parsed.rates : row?.pending?.rates
    const p = { ...rec, facts, ...(keepRates ? { rates: keepRates } : {}) }
    setBusy(true)
    const { data, error } = await supabase.rpc('kb_save_product', { p_id: id ?? null, p })
    setBusy(false)
    if (error) { setError(says(error.message)); return }
    if (isNew) { nav(`/kb/products/${data}`, { replace: true }); return }
    setMsg(row?.pending_state === 'check' ? 'Saved. The change is a draft again: send it for check when ready.' : 'Draft saved.')
    load()
  }
  async function call(fn: string, args: Record<string, unknown>, ok: string) {
    setError(''); setMsg(''); setBusy(true)
    const { data, error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setError(says(error.message)); return false }
    if (fn === 'kb_discard_draft' && data === true) { nav('/kb/products', { replace: true }); return true }
    setMsg(ok); load(); return true
  }

  if (!ready) return <div className="empty">Loading…</div>
  if (!isNew && !row) return <main className="page"><div className="card">Product record not found. <Link to="/kb/products">Back to product records</Link></div></main>

  const st = row ? productState(row, usable.has(row.id)) : { text: 'New record', tone: 'info' as const }
  const steps = ['Draft', 'Waiting for check', 'Checked, in Compare products']
  const at = row?.pending_state === 'check' ? 1 : row && !row.pending && row.status === 'verified' ? 2 : 0
  const draftChanges = row?.pending ? changes(live, row.pending, !!row.pending.rates) : []
  const title = rec.name || 'New product record'
  const docSelect = (value: string | undefined, onChange: (v: string) => void, label: string, blank = 'Choose a document') => (
    <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{blank}</option>
      {docOptions.map((d) => <option key={d.id} value={d.id}>{docLabel(d)} · {d.doc_type}{d.replaced_by ? ' (older version)' : d.status === 'new' ? ' (not checked yet)' : ''}</option>)}
    </select>
  )

  return (
    <main className="page">
      <KbHeader tab="products" />
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <p className="muted small" style={{ margin: 0 }}><Link to="/kb/products">Product records</Link> › {rec.insurer || 'New'}</p>
          <h2 style={{ fontSize: 22 }}>{title}</h2>
        </div>
        <span className={`pill ${st.tone}`}>{st.text}</span>
      </div>
      <ol className="steps" aria-label="Checking steps">
        {steps.map((s, i) => <li key={s} className={i === at ? 'on' : i < at ? 'done' : ''} aria-current={i === at ? 'step' : undefined}>{s}</li>)}
      </ol>
      {row?.pending_note && <div className="notice warn" role="status"><strong>{row.pending_note.startsWith('New version') ? 'Re-check needed' : 'Sent back'}:</strong> {row.pending_note}</div>}
      {row?.status === 'verified' && row.pending && <div className="notice" role="status">The checked version (v{row.version}) stays in Compare products until these changes are checked.</div>}
      {msg && <div className="notice ok" role="status">{msg}</div>}
      {error && <div className="error" role="alert">{error}</div>}

      <div className="kb-split">
        <div className="kb-main">
          <section className="card" aria-labelledby="kb-info">
            <h3 id="kb-info" className="eyebrow">Product information and eligibility</h3>
            <div className="form-grid">
              <label className="field">Insurer
                <input type="text" list="kb-ins" value={rec.insurer} onChange={(e) => set('insurer', e.target.value)} />
                <datalist id="kb-ins">{insurers.map((x) => <option key={x} value={x} />)}</datalist>
              </label>
              <label className="field">Product name<input type="text" value={rec.name} onChange={(e) => set('name', e.target.value)} /></label>
              <label className="field">Category
                <select value={rec.category} onChange={(e) => set('category', e.target.value)}><option>Insurance</option><option>Investment</option></select>
              </label>
              <label className="field">Onshore / offshore
                <select value={rec.jurisdiction} onChange={(e) => set('jurisdiction', e.target.value)}><option>Onshore</option><option>Offshore</option></select>
              </label>
              <label className="field">Entry age from (next birthday)<input type="number" min={0} max={100} value={rec.entry_age_min} onChange={(e) => set('entry_age_min', e.target.value)} /></label>
              <label className="field">Entry age to<input type="number" min={0} max={100} value={rec.entry_age_max} onChange={(e) => set('entry_age_max', e.target.value)} /></label>
              <label className="field">Minimum sum assured (optional)<input type="number" min={0} value={rec.sa_min ?? ''} onChange={(e) => set('sa_min', e.target.value || null)} /></label>
              <label className="field">Maximum sum assured (optional)<input type="number" min={0} value={rec.sa_max ?? ''} onChange={(e) => set('sa_max', e.target.value || null)} /></label>
            </div>
            <fieldset className="field"><legend>Policy currencies</legend>
              <div className="row" style={{ gap: '6px 18px' }}>{CURRENCIES.map((c) => (
                <label key={c} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.currencies.includes(c)} onChange={(e) => toggle('currencies', c, e.target.checked)} /> {c}</label>))}</div>
            </fieldset>
            <fieldset className="field"><legend>Who can apply</legend>
              <div className="row" style={{ gap: '6px 18px' }}>{RESIDENCIES.map((c) => (
                <label key={c} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.residency.includes(c)} onChange={(e) => toggle('residency', c, e.target.checked)} /> {c}</label>))}</div>
            </fieldset>
            <div className="row" style={{ gap: '6px 24px' }}>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.dpi} onChange={(e) => set('dpi', e.target.checked)} /> Direct Purchase Insurance (DPI)</label>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.has_tpd} onChange={(e) => set('has_tpd', e.target.checked)} /> Has TPD cover</label>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.has_ci} onChange={(e) => set('has_ci', e.target.checked)} /> Has critical illness cover (built in or rider)</label>
            </div>
            <p className="small muted" style={{ margin: 0 }}>These fields are taken from the Product Summary named below. Compare products uses them to decide which plans fit a client.</p>
          </section>

          <section className="card" aria-labelledby="kb-src">
            <h3 id="kb-src" className="eyebrow">Source documents</h3>
            {!rec.insurer.trim() && <p className="small muted" style={{ margin: 0 }}>Fill in the insurer to choose its documents.</p>}
            <div className="form-grid">
              <label className="field">Product Summary{docSelect(rec.facts._ps?.doc, (v) => setFact('_ps', { doc: v }), 'Product Summary')}</label>
              <label className="field">Rate sheet{docSelect(rec.facts._rs?.doc, (v) => setFact('_rs', { doc: v }), 'Rate sheet', 'None')}</label>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Upload documents on the <Link to="/kb">Documents</Link> tab first. A record can only be checked once every document it names is checked and in date.</p>
          </section>

          <section className="card" aria-labelledby="kb-facts">
            <h3 id="kb-facts" className="eyebrow">Product facts (as Compare products shows them)</h3>
            <p className="small muted" style={{ margin: 0 }}>Write each fact as the document says it, and name the page. Leave a fact empty when the document doesn't mention it: Compare products then shows "Not available".</p>
            <div className="tablewrap">
              <table className="kb-facts">
                <thead><tr><th style={{ width: '24%' }}>Fact</th><th>Value</th><th style={{ width: '26%' }}>Source</th><th style={{ width: 80 }}>Page</th></tr></thead>
                <tbody>
                  {FACT_FIELDS.flatMap((r, i) => {
                    const out = []
                    if (i === 0 || FACT_FIELDS[i - 1].cat !== r.cat) { out.push(<tr key={`c-${r.cat}`} className="cat"><th colSpan={4}>{r.cat}</th></tr>) }
                    const f = rec.facts[r.key]
                    out.push(
                      <tr key={r.key}>
                        <th scope="row">{r.label}</th>
                        <td><input type="text" aria-label={r.label} value={f?.v ?? ''} placeholder="Not available" onChange={(e) => setFact(r.key, { v: e.target.value })} /></td>
                        <td>{docSelect(f?.doc, (v) => setFact(r.key, { doc: v }), `Source for ${r.label}`, ps ? 'Product Summary' : 'Choose a document')}</td>
                        <td><input type="number" min={1} aria-label={`Page for ${r.label}`} value={f?.page ?? ''} onChange={(e) => setFact(r.key, { page: e.target.value ? Number(e.target.value) : undefined })} /></td>
                      </tr>,
                    )
                    return out
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="kb-rates">
            <h3 id="kb-rates" className="eyebrow">Premium rates (from the rate sheet)</h3>
            <p className="small muted" style={{ margin: 0 }}>
              Annual premium per 1,000 of sum assured, paying to age 65, by age next birthday, gender and smoker status; ci_rate is the extra for a
              critical illness rider. One line each, as <code>{RATES_HEADER}</code>. You can paste from Excel. Compare products uses them for the indicative premium.
            </p>
            <textarea aria-label="Premium rate table (CSV)" rows={8} value={ratesText} spellCheck={false} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
              onChange={(e) => { setRatesText(e.target.value); setRatesTouched(true) }} />
            <div className="row small" style={{ gap: 12 }}>
              <label className="btn small">Load a CSV file
                <input type="file" accept=".csv,.txt" hidden onChange={async (e) => { const x = e.target.files?.[0]; if (x) { setRatesText(await x.text()); setRatesTouched(true) } }} />
              </label>
              {parsed.error ? <span className="error">{parsed.error}</span>
                : <span className="muted">{parsed.rates.length} rate{parsed.rates.length === 1 ? '' : 's'}{ratesTouched ? ' (changed, saved with the draft)' : liveRates.length && !row?.pending?.rates ? ' (the checked rates)' : ''}</span>}
            </div>
          </section>
        </div>

        <aside className="kb-side">
          <section className="card" aria-label="Check">
            <h3 className="eyebrow">Check</h3>
            <button className="btn primary" onClick={save} disabled={busy || (!dirty && !isNew)}>{busy ? 'Saving…' : 'Save draft'}</button>
            {row?.pending && row.pending_state === 'draft' && (
              <button className="btn" onClick={() => call('kb_send_for_check', { p_id: row.id }, 'Sent for check. A BSD person who did not make the change checks it next.')} disabled={busy || dirty}>Send for check</button>
            )}
            {dirty && row?.pending_state === 'draft' && <span className="small muted">Save your changes before sending them for check.</span>}
            {row?.pending_state === 'check' && !canCheck && (
              <p className="small muted" style={{ margin: 0 }}>{maker ? 'Waiting for a BSD person who did not make these changes to check them. Editing takes the change back to draft.' : 'Waiting for a BSD person to check it.'}</p>
            )}
            {canCheck && <>
              <p className="small muted" style={{ margin: 0 }}>Compare each fact with the document page it names, then:</p>
              <button className="btn primary" onClick={() => call('kb_check_product', { p_id: row!.id }, 'Checked. Compare products now uses this version.')} disabled={busy || dirty}>Mark as checked</button>
              <button className="btn" onClick={() => setDialog('back')} disabled={busy}>Send back</button>
            </>}
            {row?.pending && draftChanges.length > 0 && (
              <div>
                <span className="small muted">What the draft changes</span>
                <ul className="small changes">{draftChanges.slice(0, 30).map((c) => <li key={c}>{c}</li>)}</ul>
              </div>
            )}
            {row?.pending && <button className="linkbtn danger" onClick={() => call('kb_discard_draft', { p_id: row.id }, 'Draft discarded.')} disabled={busy}>
              {row.verified_at ? 'Discard the draft changes' : 'Delete this draft product'}</button>}
            {checker && row?.status === 'verified' && <button className="linkbtn danger" onClick={() => setDialog('withdraw')} disabled={busy}>Withdraw from Compare products</button>}
          </section>

          {row && (
            <section className="card" aria-label="Source documents in use">
              <h3 className="eyebrow">Documents named</h3>
              <ul className="small plain">
                {[...named].map((d) => docs.find((x) => x.id === d)).filter(Boolean).map((d) => {
                  const s = docState(d!)
                  return <li key={d!.id}>{docLabel(d!)} <span className={`pill ${s.tone}`}>{s.text}</span>{d!.valid_until && <span className="muted"> · valid until {fmtDate(d!.valid_until)}</span>}</li>
                })}
                {!named.size && <li className="muted">None yet</li>}
              </ul>
            </section>
          )}

          {row && (
            <section className="card" aria-label="Version history">
              <h3 className="eyebrow">Version history</h3>
              <ul className="small plain">
                {history.map((h) => <li key={h.id}>v{h.version} · checked by {nameOf(people, h.checked_by)} on {fmtDateTime(h.checked_at)}{h.changed_by ? ` · made by ${nameOf(people, h.changed_by)}` : ''}</li>)}
                {!history.length && <li className="muted">{row.verified_at ? `v${row.version} (checked before the history began)` : 'Not checked yet'}</li>}
              </ul>
              {row.pending_at && <p className="small muted" style={{ margin: 0 }}>Draft last saved {fmtDateTime(row.pending_at)} by {nameOf(people, row.pending_by)}.</p>}
            </section>
          )}
        </aside>
      </div>

      {dialog === 'back' && <ReasonDialog title="Send back for changes" confirmLabel="Send back" fieldLabel="What needs changing?"
        onCancel={() => setDialog(null)} onConfirm={async (note) => { if (await call('kb_send_back_product', { p_id: row!.id, p_note: note }, 'Sent back with your note.')) setDialog(null) }} />}
      {dialog === 'withdraw' && <ReasonDialog title="Withdraw from Compare products" confirmLabel="Withdraw" fieldLabel="Reason"
        onCancel={() => setDialog(null)} onConfirm={async (r) => { if (await call('kb_withdraw_product', { p_id: row!.id, p_reason: r }, 'Withdrawn. It no longer appears in Compare products.')) setDialog(null) }} />}
    </main>
  )
}
