// The "Find and compare products" pop-up on the PI request form.
// Step 1 (wireframe 4): filters filled in from the form, and the Knowledge Bank term products in search that match.
// "Exclude sample products" leaves out the made-up "(sample)" products (Kumar, 25 Nov 2026).
// Step 2 (wireframe 5): the chosen 2 or 3 side by side, by category, with the source of each value.
// Factual only: the list is sorted by premium or insurer, never by a "best match" (no advice, MAS).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CLIENT_TYPES, CURRENCIES, RESIDENCIES } from '../lib/formOptions'
import {
  AGES_NOT_STATED, AGES_NOTE, AUTO_NOTE, AUTO_TAG, DISCLAIMER, blankText, comparisonRows, withoutSamples, coverFor, premiumFor, productLabel, whyNot, type Kb, type KbProduct, type Needs,
} from '../lib/kb'
import { buildComparisonPdf } from '../lib/kbPdf'
import { AmountInput } from './ui'
import { fmtNum } from '../lib/num'

export const MAX_COMPARE = 3

const fmt = (cur: string, x: number) => `${cur} ${fmtNum(Math.round(x))}`
const COL_HEAD = ['Product (9)', '1st Product (12)', '2nd Product (13)']

const NO_SAMPLES_KEY = 'kb.excludeSamples'
function savedNoSamples() { try { return localStorage.getItem(NO_SAMPLES_KEY) === '1' } catch { return false } }

export default function ProductMatrix({ kb: allKb, initial, mainId, selected, onUse, onClose, standalone, footer }: {
  kb: Kb
  initial: Needs
  mainId: string | null          // the product on the form (field 9), if it is from the Knowledge Bank
  selected: string[]             // products already on the form (9, 12, 13)
  onUse?: (ids: string[]) => void
  onClose?: () => void
  /** The Product Comparison Matrix page: shown in the page (not a pop-up), with gender, smoker and CI filters too. */
  standalone?: boolean
  /** What to offer under the side-by-side table instead of "Use these products" (the page's "Add to PI request"). */
  footer?: (products: KbProduct[], needs: Needs) => ReactNode
}) {
  const [n, setN] = useState<Needs>(initial)
  const [noSamples, setNoSamples] = useState(savedNoSamples)
  const kb = useMemo(() => withoutSamples(allKb, noSamples), [allKb, noSamples])
  const samples = allKb.products.filter((p) => p.is_sample).length
  const switchSamples = (on: boolean) => { setNoSamples(on); try { localStorage.setItem(NO_SAMPLES_KEY, on ? '1' : '0') } catch { /* private window */ } }
  const [sel, setSel] = useState<string[]>(() => selected.filter((id) => allKb.products.some((p) => p.id === id)).slice(0, MAX_COMPARE))
  const [sort, setSort] = useState<'premium' | 'insurer'>('premium')
  const [step, setStep] = useState<'results' | 'table'>('results')
  const [diffOnly, setDiffOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLElement>(null)
  const set = <K extends keyof Needs>(k: K, v: Needs[K]) => setN((s) => ({ ...s, [k]: v }))

  useEffect(() => {
    if (standalone) return
    box.current?.querySelector<HTMLElement>('select, input, button')?.focus()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose, step, standalone])

  const insurers = useMemo(() => [...new Set(kb.products.map((p) => p.insurer))], [kb])
  const { ok, out } = useMemo(() => {
    const rows = kb.products.map((p) => ({ p, why: whyNot(kb, p, n) }))
    const ok = rows.filter((r) => !r.why.length).map((r) => {
      const sa = n.mode === 'coverage' ? n.amount : coverFor(kb, r.p, n)
      return { p: r.p, sa, prem: sa ? premiumFor(kb, r.p, n, sa) : null }
    })
    ok.sort((a, b) => sort === 'insurer'
      ? a.p.insurer.localeCompare(b.p.insurer) || a.p.name.localeCompare(b.p.name)
      : (a.prem ?? Infinity) - (b.prem ?? Infinity) || a.p.insurer.localeCompare(b.p.insurer))
    return { ok, out: rows.filter((r) => r.why.length) }
  }, [kb, n, sort])
  // Only products that still match can be compared (a filter change can take one out).
  const picked = sel.filter((id) => ok.some((r) => r.p.id === id))
  const chosen = picked.map((id) => kb.products.find((p) => p.id === id)!)
  // The form's product goes first, as in the deck (9, then 12 and 13).
  const ordered = mainId && picked.includes(mainId) ? [chosen.find((p) => p.id === mainId)!, ...chosen.filter((p) => p.id !== mainId)] : chosen

  const toggle = (id: string, on: boolean) => setSel((s) => on ? (s.includes(id) || s.length >= MAX_COMPARE ? s : [...s, id]) : s.filter((x) => x !== id))

  async function download() {
    setBusy(true); setError('')
    try {
      const blob = await buildComparisonPdf(kb, ordered, n)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `Term product comparison ${new Date().toISOString().slice(0, 10)}.pdf`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    } catch (e) { setError(`The summary could not be made: ${(e as Error).message}`) }
    setBusy(false)
  }

  const badge = (i: number | string) => <span className="wf-badge" aria-hidden="true">{i}</span>

  const hint = (t: string) => (standalone ? null : <span className="small muted">{t}</span>)
  const title = step === 'results' ? 'Find term products to compare' : 'Side-by-side comparison'
  const body = (
      <>
        <div className="row between">
          <div>
            <p className="muted small" style={{ margin: 0 }}>{standalone ? 'Product Comparison Matrix' : 'PI request'} › {step === 'results' ? 'Product Matrix' : 'Compare'}</p>
            <h2 style={{ margin: 0 }}>{title}</h2>
          </div>
          {!standalone && <button type="button" className="btn" onClick={onClose} aria-label="Close">×</button>}
        </div>

        {step === 'results' ? <>
          <p className="small muted" style={{ margin: 0 }}>{standalone
            ? "Fill in the client's needs to see the Knowledge Bank term products that fit. Pick 2 or 3 to compare side by side."
            : "Filled in from the request form. Change any filter to see other products. Changes here don't change the form."}</p>
          <div className="matrix-filters">
            <div className="field wf"><span className="wf-head">{badge(1)}<label htmlFor="m-f1">Client profile</label></span>
              <select id="m-f1" value={n.profile} onChange={(e) => set('profile', e.target.value)}>
                {CLIENT_TYPES.map((x) => <option key={x}>{x}</option>)}
              </select>{hint('From client type (4)')}</div>
            <div className="field wf"><span className="wf-head">{badge(2)}<label htmlFor="m-f2">Age next birthday</label></span>
              <input id="m-f2" type="number" min={1} max={100} value={n.age ?? ''} onChange={(e) => set('age', e.target.value ? Number(e.target.value) : null)} />
              {hint('From date of birth (7)')}</div>
            <div className="field wf"><span className="wf-head">{badge(3)}<label htmlFor="m-f3">Residency</label></span>
              <select id="m-f3" value={n.residency} onChange={(e) => set('residency', e.target.value)}>
                {RESIDENCIES.map((x) => <option key={x}>{x}</option>)}
              </select>{hint('From residency (5)')}</div>
            <div className="field wf"><span className="wf-head">{badge(4)}<label htmlFor="m-f4">Currency</label></span>
              <select id="m-f4" value={n.currency} onChange={(e) => set('currency', e.target.value)}>
                {CURRENCIES.map((x) => <option key={x}>{x}</option>)}
              </select>{hint('From currency (10)')}</div>
            <div className="field wf"><span className="wf-head">{badge(5)}<label htmlFor="m-f5">Objective</label></span>
              <select id="m-f5" value="Protection" onChange={() => undefined}>
                <option>Protection</option><option disabled>Estate (later)</option><option disabled>Wealth (later)</option>
              </select><span className="small muted">Term plans only for now</span></div>
            <div className="field wf"><span className="wf-head">{badge(6)}Budget or coverage</span>
              <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <select aria-label="Budget or coverage" value={n.mode} style={{ width: 'auto', flex: '0 0 auto' }}
                  onChange={(e) => set('mode', e.target.value as Needs['mode'])}>
                  <option value="coverage">Coverage</option><option value="budget">Budget a year</option>
                </select>
                <AmountInput aria-label={n.mode === 'coverage' ? 'Sum assured' : 'Budget a year'} style={{ minWidth: 0, flex: 1 }} value={n.amount || ''}
                  onValue={(v) => set('amount', Number(v) || 0)} />
              </div>{hint('From sum assured / premium (11)')}</div>
            <div className="field wf"><span className="wf-head">{badge(7)}<label htmlFor="m-f7">Insurer</label></span>
              <select id="m-f7" value={n.insurer} onChange={(e) => set('insurer', e.target.value)}>
                {['All', ...insurers].map((x) => <option key={x}>{x}</option>)}
              </select></div>
            <div className="field wf"><span className="wf-head">{badge(8)}<label htmlFor="m-f8">Category</label></span>
              <select id="m-f8" value={n.category} onChange={(e) => set('category', e.target.value)}>
                {['All', 'Insurance', 'Investment'].map((x) => <option key={x}>{x}</option>)}
              </select></div>
            <div className="field wf"><span className="wf-head"><span className="wf-badge blank" aria-hidden="true" /><label htmlFor="m-fj">Onshore / offshore</label></span>
              <select id="m-fj" value={n.jurisdiction} onChange={(e) => set('jurisdiction', e.target.value)}>
                {['All', 'Onshore', 'Offshore'].map((x) => <option key={x}>{x}</option>)}
              </select></div>
            {standalone && <>
              <div className="field wf"><span className="wf-head"><span className="wf-badge blank" aria-hidden="true" /><label htmlFor="m-fg">Gender</label></span>
                <select id="m-fg" value={n.gender} onChange={(e) => set('gender', e.target.value)}><option>Male</option><option>Female</option></select></div>
              <div className="field wf"><span className="wf-head"><span className="wf-badge blank" aria-hidden="true" /><label htmlFor="m-fs">Smoker</label></span>
                <select id="m-fs" value={n.smoker ? 'yes' : 'no'} onChange={(e) => set('smoker', e.target.value === 'yes')}><option value="no">Non-smoker</option><option value="yes">Smoker</option></select></div>
              <div className="field wf"><span className="wf-head"><span className="wf-badge blank" aria-hidden="true" /><label htmlFor="m-fc">Critical illness cover</label></span>
                <select id="m-fc" value={n.ci ? 'yes' : 'no'} onChange={(e) => set('ci', e.target.value === 'yes')}><option value="no">Not needed</option><option value="yes">Needed</option></select></div>
            </>}
          </div>

          {samples > 0 && (
            <div className="row" style={{ gap: 10 }}>
              <button type="button" className={`btn small${noSamples ? ' primary' : ''}`} aria-pressed={noSamples} onClick={() => switchSamples(!noSamples)}>
                {noSamples ? '✓ Sample products excluded' : 'Exclude sample products'}</button>
              <span className="small muted">{noSamples ? `${fmtNum(samples)} made-up "(sample)" product${samples === 1 ? ' is' : 's are'} left out of the search.` : `Includes ${fmtNum(samples)} made-up "(sample)" product${samples === 1 ? '' : 's'}.`}</span>
            </div>
          )}
          <div className="row between">
            <h3 style={{ margin: 0 }} aria-live="polite">{fmtNum(ok.length)} matching term product{ok.length === 1 ? '' : 's'}</h3>
            <label className="row small" style={{ gap: 8 }}>Sort by
              <select value={sort} style={{ width: 'auto' }} onChange={(e) => setSort(e.target.value as 'premium' | 'insurer')}>
                <option value="premium">{n.mode === 'coverage' ? 'Min premium' : 'Cover the budget buys'}</option><option value="insurer">Insurer</option>
              </select></label>
          </div>
          <div className="wf-row">{badge(9)}
            <div className="tablewrap">
              <table className="matrix-results">
                <thead><tr><th>Select</th><th>Insurer</th><th>Product</th><th>Category</th><th>Jurisdiction</th>
                  <th className="num">{n.mode === 'coverage' ? 'Min premium a year' : 'Cover for the budget'}</th></tr></thead>
                <tbody>
                  {ok.map(({ p, sa, prem }) => {
                    const on = picked.includes(p.id)
                    return (
                      <tr key={p.id} className={on ? 'picked' : ''}>
                        <td><input type="checkbox" checked={on} disabled={!on && picked.length >= MAX_COMPARE}
                          aria-label={`Select ${productLabel(p)}`} onChange={(e) => toggle(p.id, e.target.checked)} /></td>
                        <td>{p.insurer}</td>
                        <td><strong>{p.name}</strong>{p.id === mainId && <span className="pill info" style={{ marginLeft: 6 }}>On your form (9)</span>}
                          {p.auto_read && <span className="pill warn" style={{ marginLeft: 6 }} title="Read from the insurer's documents by the system; no one has checked the values yet">{AUTO_TAG}</span>}
                          {p.ages_stated === false && <span className="pill warn" style={{ marginLeft: 6 }} title="The age filter skips this product: check the entry ages with the insurer">{AGES_NOT_STATED}</span>}</td>
                        <td className="small">{p.category} · {p.product_type}{p.dpi ? ' (DPI)' : ''}</td>
                        <td className="small">{p.jurisdiction}</td>
                        <td className="num">{n.mode === 'coverage'
                          ? (prem != null ? <strong>{fmt(n.currency, prem)}</strong> : <span className="muted small">No rate for this age</span>)
                          : (sa ? <><strong>{fmt(n.currency, sa)}</strong><br /><span className="small muted">{prem != null ? `${fmt(n.currency, prem)} a year` : ''}</span></> : <span className="muted small">No rate for this age</span>)}</td>
                      </tr>
                    )
                  })}
                  {!ok.length && <tr><td colSpan={6} className="muted">No product matches. Change a filter above.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          {out.length > 0 && (
            <details className="small">
              <summary style={{ cursor: 'pointer' }}>{fmtNum(out.length)} product{out.length === 1 ? " doesn't" : "s don't"} match</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {out.map((r) => <li key={r.p.id}>{productLabel(r.p)}: {r.why.join(', ')}</li>)}
              </ul>
            </details>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            Knowledge Bank products appear as soon as their documents are uploaded; those marked "{AUTO_TAG}" were read by the system and not yet checked by a person. Premiums are indicative, for the gender and smoker status on the form
            {n.ci ? ', with a critical illness rider' : ''}, paying to age 65. Plans without critical illness cover are left out when the form asks for it.
          </p>
          <div className="matrix-foot row between">
            <span className="small muted">Selected {fmtNum(picked.length)} of {fmtNum(MAX_COMPARE)} (pick at least 2)</span>
            <div className="wf-row">{badge(10)}
              <button type="button" className="btn primary" disabled={picked.length < 2} onClick={() => { setStep('table'); setError('') }}>
                Compare selected ({fmtNum(picked.length)})</button>
            </div>
          </div>
        </> : <>
          <div className="row between">
            <button type="button" className="linkbtn" onClick={() => setStep('results')}>← Back to matching products</button>
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} /> Show only rows that differ</label>
          </div>
          <CompareTable kb={kb} products={ordered} needs={n} diffOnly={diffOnly} />
          <div className="disclaimer small">{DISCLAIMER}{ordered.some((p) => p.auto_read) && <><br /><strong>{AUTO_NOTE}</strong></>}{ordered.some((p) => p.ages_stated === false) && <><br /><strong>{AGES_NOTE}</strong></>}</div>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="matrix-foot row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={download} disabled={busy}>{busy ? 'Making the PDF…' : 'Download summary (PDF)'}</button>
            {!footer && <button type="button" className="btn primary" onClick={() => onUse?.(ordered.map((p) => p.id))}>
              Use these {fmtNum(ordered.length)} products in the PI request</button>}
          </div>
          {footer?.(ordered, n)}
        </>}
      </>
  )
  if (standalone) return <section ref={box} className="card matrix" aria-label={title}>{body}</section>
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div ref={box as React.RefObject<HTMLDivElement>} className="card dialog matrix" role="dialog" aria-modal="true" aria-label={title}>
        {body}
      </div>
    </div>
  )
}

function CompareTable({ kb, products, needs, diffOnly }: { kb: Kb; products: KbProduct[]; needs: Needs; diffOnly: boolean }) {
  const rows = comparisonRows(kb, products, needs).filter((r) => !diffOnly || r.differ || r.key === '_insurer')
  return (
    <div className="tablewrap">
      <table className="compare-table">
        <thead><tr><th scope="col" className="lbl">Category</th>
          {products.map((p, i) => <th key={p.id} scope="col"><span className="small muted">{COL_HEAD[i]} · {p.insurer}</span><br />{p.name}
            {p.auto_read && <><br /><span className="pill warn">{AUTO_TAG}</span></>}
            {p.ages_stated === false && <><br /><span className="pill warn">{AGES_NOT_STATED}</span></>}</th>)}
        </tr></thead>
        <tbody>
          {rows.flatMap((r, i) => {
            const out = []
            if (i === 0 || rows[i - 1].cat !== r.cat) out.push(<tr key={`c-${r.cat}`} className="cat"><th colSpan={products.length + 1} scope="colgroup">{r.cat}</th></tr>)
            out.push(
              <tr key={r.key}>
                <th scope="row" className="lbl">{r.label}</th>
                {r.cells.map((c, i) => (
                  <td key={products[i].id} className={r.differ && r.key !== '_insurer' ? 'differ' : ''}>
                    {c.text ? c.text : <span className="muted">{blankText(products[i])}</span>}
                    {c.source && <span className="src">Source: {c.source}</span>}
                  </td>
                ))}
              </tr>,
            )
            return out
          })}
        </tbody>
      </table>
    </div>
  )
}
