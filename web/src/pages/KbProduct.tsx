// One Knowledge Bank product record: its facts (each naming a document and page) and premium rates. No check step
// (Kumar, 25 Nov 2026): saving puts it in search at once; changing it is optional. What the reader filled in is marked
// "From document" (or "AI", when the free AI helper filled it) until someone saves the record or marks it as reviewed.
import { sayError } from '../lib/update'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { nameOf, usePeople } from '../lib/people'
import { fmtDate, fmtDateTime, says } from '../lib/options'
import { CURRENCIES, RESIDENCIES, STANDARD_INSURERS } from '../lib/formOptions'
import {
  FACT_FIELDS, RATES_HEADER, finOutOfDate, blankRecord, blocking, docTypeName, docLabel, docState, liveRecord, loadDocs, loadUsable, parseRates, productState, ratesToCsv,
  whyNotSearchable, type Fact, type HistoryRow, type KbDoc, type KbProductRow, type ProductRecord, type Rate,
} from '../lib/kbAdmin'
import { AmountInput, ReasonDialog } from '../components/ui'
import { DocDialog, KbHeader, type Created } from './KnowledgeHub'
import { ratesCsv, readFile, readRates, readSummary, readableName } from '../lib/kbExtract'
import { loadProducts } from '../lib/kbAdmin'
import { fmtNum, plain } from '../lib/num'
import { aiAskCount, aiKeysOf, fillWithAi, type Reading } from '../lib/kbAuto'
import { AI_MODELS } from '../lib/aiConfig'
import { FINANCING_NOTE, GROUPS, groupLabel, groupOf, isFinancing, planLabel, plansIn } from '../lib/families'
import { FIN_CURRENCIES, FIN_RATES_HEADER, finRatesCsv, parseFinRates, readFinancing } from '../lib/kbFinancing'
import { rowApplies } from '../lib/kb'

const HOW: Record<string, string> = { edit: 'saved', read: 'read from an upload', migrated: 'put live when checks were removed', checked: 'checked' }

export default function KbProduct() {
  const { id } = useParams()
  const isNew = !id
  const nav = useNavigate()
  const people = usePeople()
  const [row, setRow] = useState<KbProductRow | null>(null)
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [usable, setUsable] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [liveRates, setLiveRates] = useState<Rate[]>([])
  const [rec, setRec] = useState<ProductRecord>(blankRecord())
  const [saved, setSaved] = useState('')            // the record as last saved, to spot unsaved changes
  const [ratesText, setRatesText] = useState('')
  const [ratesTouched, setRatesTouched] = useState(false)
  // Premium financing: the cost-of-funds and drawdown rates, as CSV.
  const [finText, setFinText] = useState('')
  const [finTouched, setFinTouched] = useState(false)
  const [ready, setReady] = useState(isNew)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'withdraw' | 'delete' | null>(null)
  // Reading a Product Summary or rate sheet into the form.
  const [params] = useSearchParams()
  const [reading, setReading] = useState('')
  const [fromDoc, setFromDoc] = useState<Set<string>>(new Set())   // fact keys and fields filled in by the reader
  const [readNotes, setReadNotes] = useState<string[]>([])
  const [aiSet, setAiSet] = useState<Set<string>>(new Set())      // what the AI helper filled in
  const [lastRead, setLastRead] = useState<Reading | null>(null)   // the last Product Summary read, for the AI helper
  const [aiState, setAiState] = useState('')
  useEffect(() => () => { import('../lib/aiModel').then((m) => m.releaseAi()).catch(() => {}) }, [])
  const [upload, setUpload] = useState<'Product Summary' | 'Rate sheet' | 'Product Financing' | null>(null)
  const [uploadKey, setUploadKey] = useState<'_ps' | '_cof'>('_ps')
  const [products, setProducts] = useState<KbProductRow[]>([])

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
      const base = liveRecord(p)
      setRec({ ...base, facts: base.facts ?? {} }); setSaved(JSON.stringify({ ...base, rates: undefined }))
      setRatesText(ratesToCsv(lr)); setRatesTouched(false)
      setFinText(finRatesCsv(p.fin_rates ?? [])); setFinTouched(false)
      setFromDoc(new Set(p.auto_read ? (p.auto_fields ?? []) : []))
      setAiSet(new Set(p.auto_read ? aiKeysOf(p.auto_fields) : []))
    }
    setReady(true)
  }, [id])
  useEffect(() => { load() }, [load])

  const set = <K extends keyof ProductRecord>(k: K, v: ProductRecord[K]) => setRec((s) => ({ ...s, [k]: v }))
  const setFact = (key: string, patch: Partial<Fact>) => setRec((s) => ({ ...s, facts: { ...s.facts, [key]: { ...s.facts[key], ...patch } } }))
  const toggle = (k: 'currencies' | 'residency', v: string, on: boolean) => set(k, on ? [...rec[k], v] : rec[k].filter((x) => x !== v))
  const parsed = useMemo(() => parseRates(ratesText), [ratesText])
  const finParsed = useMemo(() => parseFinRates(finText), [finText])
  const fin = isFinancing(rec.product_type)
  const dirty = JSON.stringify({ ...rec, rates: undefined }) !== saved || ratesTouched || finTouched
  const insurers = useMemo(() => [...new Set([...docs.map((d) => d.insurer), ...STANDARD_INSURERS])], [docs])
  // Documents to pick from: this insurer's current versions, plus any the record already names.
  const named = new Set(Object.values(rec.facts).map((f) => f?.doc).filter(Boolean))
  const docOptions = docs.filter((d) => named.has(d.id) || (!d.replaced_by && (!rec.insurer.trim() || d.insurer.toLowerCase() === rec.insurer.trim().toLowerCase())))
  const ps = rec.facts._ps?.doc


  /** Reads a Product Summary or rate sheet (an uploaded document, or the file just uploaded) into the draft.
   *  Nothing is saved until Save: check what was filled in if you wish, then save. */
  async function fillFrom(docId: string, kind: 'summary' | 'rates' | 'financing', file?: File, all = docs, slot?: '_ps' | '_cof') {
    const d = all.find((x) => x.id === docId)
    const name = file?.name ?? d?.file_name ?? ''
    setError(''); setMsg('')
    if (!readableName(name)) { setError('Only PDF, Excel (.xlsx) or CSV files can be read. Fill in the details by hand.'); return }
    setReading(`Reading ${name}…`)
    try {
      let data: ArrayBuffer
      if (file) data = await file.arrayBuffer()
      else {
        if (!d?.storage_path) throw new Error('This document has no file.')
        const dl = await supabase.storage.from('kb-docs').download(d.storage_path)
        if (dl.error || !dl.data) throw new Error(dl.error?.message ?? 'Could not download the file')
        data = await dl.data.arrayBuffer()
      }
      const doc = await readFile(data, name, (done, total, ocr) => setReading(`Reading ${name}: page ${plain(Math.min(total, Math.floor(done) + 1))} of ${plain(total)}${ocr ? ' (scanned, reading the picture)' : ''}…`))
      if (kind === 'financing') {
        // A bank's financing document: the record's fields, facts and cost-of-funds rates. The slot clicked (or the
        // reader's own view: factsheet or monthly rate sheet) says which source it is.
        const r = readFinancing(doc)
        const key = slot ?? r.source
        const keys = new Set<string>()
        setRec((s) => {
          const next: ProductRecord = { ...s, product_type: r.planType, category: groupOf(r.planType), facts: { ...s.facts, [key]: { doc: docId } } }
          if (r.record.insurer && !s.insurer.trim()) { next.insurer = r.record.insurer; keys.add('insurer') }
          if (r.record.name && !s.name.trim()) { next.name = r.record.name; keys.add('name') }
          if (r.record.currencies?.length) { next.currencies = r.record.currencies; keys.add('currencies') }
          for (const [k, f] of Object.entries(r.facts)) { next.facts[k] = { v: f.v, doc: docId, page: doc.kind === 'pdf' ? f.page : undefined }; keys.add(k) }
          if (s.product_type !== r.planType) keys.add('product_type')
          return next
        })
        if (r.finRates.length) { setFinText(finRatesCsv(r.finRates)); setFinTouched(true); keys.add('_fin_rates') }
        setFromDoc((x) => new Set([...x, ...keys]))
        setAiSet((x) => new Set([...x].filter((k) => !keys.has(k))))
        setLastRead({ kind: 'financing', financing: r, summary: r, doc })
        setReadNotes(r.notes)
        setMsg(r.filled.length > 1
          ? `Filled in from ${name}: ${r.filled.join(', ')}. Each is marked "From document". Fill in anything missed, then save.`
          : `Couldn't find the details in ${name}. Fill them in by hand.`)
      } else if (kind === 'summary') {
        const r = readSummary(doc)
        const keys = new Set<string>()
        setRec((s) => {
          const next: ProductRecord = { ...s, facts: { ...s.facts, _ps: { doc: docId } } }
          for (const [k, v] of Object.entries(r.record) as [keyof ProductRecord, never][]) {
            // A record that already has a name or insurer keeps it: the reader only fills those in when blank.
            if ((k === 'name' || k === 'insurer') && String(s[k] ?? '').trim()) continue
            ;(next as unknown as Record<string, unknown>)[k] = v
            keys.add(k)
          }
          for (const [k, f] of Object.entries(r.facts)) { next.facts[k] = { v: f.v, doc: docId, page: doc.kind === 'pdf' ? f.page : undefined }; keys.add(k) }
          // The plan type the document says it is, when the record has none yet.
          if (r.planType && !s.product_type) { next.product_type = r.planType; next.category = groupOf(r.planType); keys.add('product_type') }
          return next
        })
        setFromDoc((x) => new Set([...x, ...keys]))
        setAiSet((x) => new Set([...x].filter((k) => !keys.has(k) && !(k === 'entry_age' && keys.has('entry_age_min')))))
        setLastRead({ kind: 'summary', summary: r, doc })
        setReadNotes(r.notes)
        setMsg(r.filled.length
          ? `Filled in from ${name}: ${r.filled.join(', ')}. Each is marked "From document". Fill in anything missed, then save: it is in search straight away.`
          : `Couldn't find the details in ${name}. Fill them in by hand.`)
      } else {
        const r = readRates(doc)
        if (r.error) { setReadNotes(r.notes); setError(r.error); return }
        setRatesText(ratesCsv(r.rates)); setRatesTouched(true)
        setFact('_rs', { doc: docId })
        setFromDoc((x) => new Set([...x, '_rates']))
        setReadNotes(r.notes)
        const ages = r.rates.map((x) => x.age)
        setMsg(`Read ${fmtNum(r.rates.length)} premium rates from ${name} (ages ${plain(Math.min(...ages))} to ${plain(Math.max(...ages))}${r.rates.some((x) => x.ci_rate != null) ? ', with critical illness rider rates' : ''}). Then save: it is in search straight away.`)
      }
    } catch (e) {
      setError(`Couldn't read ${name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReading('')
    }
  }

  /** Asks the free AI helper about what the reader left blank in the last Product Summary read. Only blank facts
   *  are filled (nothing typed is changed); nothing is saved until Save. */
  async function askAi() {
    if (!lastRead) return
    setError(''); setMsg('')
    setAiState('Starting the free AI helper…')
    try {
      const r = await fillWithAi(lastRead, setAiState)
      setLastRead(r)
      const docId = r.financing ? (rec.facts[r.financing.source]?.doc ?? rec.facts._ps?.doc ?? rec.facts._cof?.doc) : rec.facts._ps?.doc
      const put = new Set<string>()
      setRec((s) => {
        const next: ProductRecord = { ...s, facts: { ...s.facts } }
        for (const k of r.ai ?? []) {
          const f = r.summary!.facts[k]
          if (f) { if (!next.facts[k]?.v?.trim()) { next.facts[k] = { v: f.v, doc: docId, page: r.doc?.kind === 'pdf' ? f.page : undefined }; put.add(k) } continue }
          const rv = r.summary!.record
          if (k === 'sum_assured') continue
          if (k === 'entry_age') { next.entry_age_min = rv.entry_age_min!; next.entry_age_max = rv.entry_age_max!; put.add(k) }
          else if (k in rv) { (next as unknown as Record<string, unknown>)[k] = (rv as Record<string, unknown>)[k]; put.add(k) }
        }
        const rr = r.summary!.record
        if (put.has('tpd') && rr.has_tpd != null) next.has_tpd = rr.has_tpd
        if ((put.has('ci') || put.has('eci')) && rr.has_ci != null) next.has_ci = rr.has_ci
        return next
      })
      setAiSet((x) => new Set([...x, ...put]))
      setMsg(put.size ? `The AI helper filled ${plain(put.size)} more detail${put.size === 1 ? '' : 's'}, marked "AI". Each was checked against the document's own words, but check them before you save.`
        : 'The AI helper found nothing more that passed the checks against the document, so those details stay blank.')
    } catch (e) {
      setError(sayError(e, (x) => `The AI helper could not run in this browser: ${x.message}`))
    } finally {
      setAiState('')
    }
  }
  const aiCount = aiAskCount(lastRead)
  const aiTag = (k: string) => aiSet.has(k) && <span className="pill warn tag" title="Filled by the free AI helper from the document's own words. Check it against the document.">AI</span>

  // "New record from it" on the Documents tab: read that document as soon as the documents are loaded.
  const [autoRead, setAutoRead] = useState(false)
  useEffect(() => {
    if (!isNew || autoRead || !docs.length) return
    setAutoRead(true)
    const sum = params.get('summary'), rat = params.get('rates')
    ;(async () => {
      if (sum) await fillFrom(sum, 'summary')
      if (rat) await fillFrom(rat, 'rates')
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, docs, autoRead])

  async function uploaded(m: string, c?: Created) {
    setUpload(null)
    const d = await loadDocs()
    setDocs(d)
    if (!c) { setMsg(m); return }
    await fillFrom(c.id, c.doc_type === 'Rate sheet' ? 'rates' : c.doc_type === 'Product Financing' ? 'financing' : 'summary', c.file, d, c.doc_type === 'Product Financing' ? uploadKey : undefined)
  }

  async function save() {
    setError(''); setMsg('')
    if (parsed.error && !fin) { setError(parsed.error); return }
    if (fin && finParsed.error) { setError(finParsed.error); return }
    if (!rec.product_type) { setError('Choose the product category (plan type)'); return }
    // A fact typed without a source names the Product Summary.
    const facts: Record<string, Fact> = {}
    for (const [k, f] of Object.entries(rec.facts)) {
      if (k.startsWith('_')) { if (f?.doc) facts[k] = { doc: f.doc }; continue }
      if (!f?.v?.trim()) continue
      facts[k] = { v: f.v.trim(), doc: f.doc || ps || rec.facts._cof?.doc, page: f.page ? Number(f.page) : undefined }
    }
    const keepRates = ratesTouched && !fin ? parsed.rates : undefined
    const p = { ...rec, facts, ...(keepRates ? { rates: keepRates } : {}), ...(fin ? { fin_rates: finTouched ? finParsed.rates : rec.fin_rates ?? finParsed.rates } : { fin_rates: undefined }) }
    setBusy(true)
    const { data, error } = await supabase.rpc('kb_save_product', { p_id: id ?? null, p })
    setBusy(false)
    if (error) { setError(says(error.message)); return }
    if (isNew) { nav(`/kb/products/${data}`, { replace: true }); return }
    setMsg(row?.status === 'withdrawn' ? 'Saved. It stays withdrawn until you put it back.' : fin ? 'Saved as a new version.' : 'Saved. Compare products uses this version now.')
    setFromDoc(new Set())
    load()
  }
  async function call(fn: string, args: Record<string, unknown>, ok: string) {
    setError(''); setMsg(''); setBusy(true)
    const { data, error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setError(says(error.message)); return false }
    void data
    if (fn === 'kb_delete_product') { nav('/kb/products', { replace: true }); return true }
    setMsg(ok); load(); return true
  }

  if (!ready) return <div className="empty">Loading…</div>
  if (!isNew && !row) return <main className="page"><div className="card">Product record not found. <Link to="/kb/products">Back to product records</Link></div></main>

  const st = row ? productState(row, usable.has(row.id), docs) : { text: 'New record', tone: 'info' as const }
  // Financing rates go out of date with their document (a monthly cost-of-funds sheet's valid-until date).
  const finStale = fin && row ? finOutOfDate({ facts: rec.facts }, docs) : false
  const why = row ? whyNotSearchable(row, usable.has(row.id)) : ''
  const title = rec.name || 'New product record'
  // The facts this plan type has (and any that hold a value); every fact while no plan type is chosen.
  const factRows = FACT_FIELDS.filter((r) => !rec.product_type || rowApplies(r, rec.product_type) || rec.facts[r.key]?.v)
  const docSelect = (value: string | undefined, onChange: (v: string) => void, label: string, blank = 'Choose a document', elId?: string) => (
    <select id={elId} aria-label={elId ? undefined : label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{blank}</option>
      {docOptions.map((d) => <option key={d.id} value={d.id}>{docLabel(d)} · {docTypeName(d)}{d.replaced_by ? ' (older version)' : ''}</option>)}
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
      {why && row?.status !== 'withdrawn' && <div className="notice warn" role="status">{why}.</div>}
      {fin && <div className="notice" role="note"><strong>Premium financing.</strong> {FINANCING_NOTE} This record is kept in the Knowledge Bank and is not offered in Compare products for now.</div>}
      {finStale && <div className="notice warn" role="status"><strong>Rates out of date.</strong> A source document of this record has passed its valid-until date. Upload the bank's latest sheet as a new version of it.</div>}
      {row?.auto_read && <div className="notice warn" role="status"><strong>Auto-read, not yet reviewed.</strong> The values marked "From document" were read by the system{fin ? '' : ' and are shown in Compare products as they are'}. Reviewing them is optional: change anything wrong and save, or mark it as reviewed.{row.read_note ? ` ${row.read_note}` : ''}</div>}
      {row?.missing?.includes('entry_age') && <div className="notice warn" role="status"><strong>Entry ages not stated in the document.</strong> The product is
        searchable, but the age filter skips it and Compare products says the ages are not stated. The {plain(18)} and {plain(65)} in the entry age boxes are only
        a starting point: type the real entry ages before you save, because saving counts them as the product's ages.</div>}
      {reading && <div className="notice" role="status">{reading}</div>}
      {aiState && <div className="notice" role="status">{aiState}</div>}
      {msg && <div className="notice ok" role="status">{msg}</div>}
      {aiCount > 0 && !reading && !aiState && (
        <div className="row small" style={{ gap: 8 }}>
          <button type="button" className="btn small" onClick={askAi}
            title={`A free, open AI model runs in this browser: the document never leaves this computer. It is asked only about what the reader missed, must quote the document for every answer, and anything it gives that is not in the document is dropped. The first time, the browser downloads the model (about ${fmtNum(AI_MODELS.small.mb / 1000, 1)}–${fmtNum(AI_MODELS.gpu.mb / 1000, 1)} GB) and keeps it.`}>
            Ask the free AI helper about {plain(aiCount)} detail{aiCount === 1 ? '' : 's'} the reader missed</button>
          <span className="muted">Optional. Runs in your browser, nothing is sent. Values it fills are marked "AI".</span>
        </div>
      )}
      {readNotes.map((n) => <div key={n} className="notice warn" role="status">{n}</div>)}
      {error && <div className="error" role="alert">{error}</div>}

      <div className="kb-split">
        <div className="kb-main">
          <section className="card" aria-labelledby="kb-src">
            <h3 id="kb-src" className="eyebrow">Source documents</h3>
            <p className="small muted" style={{ margin: 0 }}>
              {fin ? "Upload the bank's financing factsheet and its monthly cost-of-funds sheet (PDF or Excel), or pick ones already in the Knowledge Bank, and the details below are read from them for you."
                : "Upload the insurer's Product Summary and rate sheet (PDF or Excel), or pick ones already in the Knowledge Bank, and the details below are read from them for you."} The reader can miss or misread things, so check each value against the document before you save.
            </p>
            <div className="form-grid">
              {fin && ([['Financing factsheet', '_ps'], ['Cost-of-funds sheet (monthly)', '_cof']] as const).map(([t, key]) => {
                const cur = docs.find((d) => d.id === rec.facts[key]?.doc)
                return (
                  <div key={key} className="field">
                    <label htmlFor={`kb-${key}`}>{t}</label>
                    {docSelect(rec.facts[key]?.doc, (v) => setFact(key, { doc: v }), t, 'None', `kb-${key}`)}
                    <div className="row small" style={{ gap: 8 }}>
                      <button type="button" className="btn small" disabled={!!reading || !cur || !readableName(cur.file_name)}
                        title={cur && !readableName(cur.file_name) ? 'Only PDF, Excel or CSV files can be read' : undefined}
                        onClick={() => fillFrom(cur!.id, 'financing', undefined, docs, key)}>Fill in from it</button>
                      <button type="button" className="btn small" disabled={!!reading}
                        onClick={async () => { if (!products.length) setProducts(await loadProducts()); setUploadKey(key); setUpload('Product Financing') }}>Upload a new Product Financing document</button>
                    </div>
                  </div>
                )
              })}
              {!fin && (['Product Summary', 'Rate sheet'] as const).map((t) => {
                const key = t === 'Rate sheet' ? '_rs' : '_ps'
                const cur = docs.find((d) => d.id === rec.facts[key]?.doc)
                return (
                  <div key={t} className="field">
                    <label htmlFor={`kb-${key}`}>{t}</label>
                    {docSelect(rec.facts[key]?.doc, (v) => setFact(key, { doc: v }), t, t === 'Rate sheet' ? 'None' : 'Choose a document', `kb-${key}`)}
                    <div className="row small" style={{ gap: 8 }}>
                      <button type="button" className="btn small" disabled={!!reading || !cur || !readableName(cur.file_name)}
                        title={cur && !readableName(cur.file_name) ? 'Only PDF, Excel or CSV files can be read' : undefined}
                        onClick={() => fillFrom(cur!.id, t === 'Rate sheet' ? 'rates' : 'summary')}>Fill in from it</button>
                      <button type="button" className="btn small" disabled={!!reading}
                        onClick={async () => { if (!products.length) setProducts(await loadProducts()); setUpload(t) }}>Upload a new {t === 'Rate sheet' ? 'rate sheet' : 'Product Summary'}</button>
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="small muted" style={{ margin: 0 }}>{fin ? "When a document it names passes its valid-until date (a monthly cost-of-funds sheet's is the end of its month), the rates show as out of date." : 'When a document it names passes its valid-until date, the product drops out of Compare products.'} Uploads are listed on the <Link to="/kb">Documents</Link> tab.</p>
          </section>

          <section className="card" aria-labelledby="kb-info">
            <h3 id="kb-info" className="eyebrow">Product information and eligibility</h3>
            <div className="form-grid">
              <label className="field">{fin ? 'Lender (bank)' : 'Insurer'}
                <input type="text" list="kb-ins" value={rec.insurer} onChange={(e) => set('insurer', e.target.value)} />
                <datalist id="kb-ins">{insurers.map((x) => <option key={x} value={x} />)}</datalist>
              </label>
              <label className="field">Product name<input type="text" value={rec.name} onChange={(e) => set('name', e.target.value)} /></label>
              <label className="field">Product category{fromDoc.has('product_type') && <span className="pill info tag">From document</span>}
                <select value={rec.product_type} onChange={(e) => setRec((s) => ({ ...s, product_type: e.target.value, category: groupOf(e.target.value) }))}>
                  {!rec.product_type && <option value="">Choose the plan type</option>}
                  {GROUPS.map((g) => <optgroup key={g} label={groupLabel(g)}>{plansIn(g).map((t) => <option key={t.key} value={t.key}>{planLabel(t.key)}</option>)}</optgroup>)}
                </select>
                {rec.product_type && <span className="small muted">{groupLabel(groupOf(rec.product_type))} product</span>}
              </label>
              <label className="field">Onshore / offshore
                <select value={rec.jurisdiction} onChange={(e) => set('jurisdiction', e.target.value)}><option>Onshore</option><option>Offshore</option></select>
              </label>
              {!fin && <>
              <label className="field">Entry age from (next birthday){aiTag('entry_age')}<input type="number" min={0} max={100} value={rec.entry_age_min} onChange={(e) => set('entry_age_min', e.target.value)} /></label>
              <label className="field">Entry age to{aiTag('entry_age')}<input type="number" min={0} max={100} value={rec.entry_age_max} onChange={(e) => set('entry_age_max', e.target.value)} /></label>
              <label className="field">Minimum sum assured (optional){aiTag('sa_min')}<AmountInput value={rec.sa_min ?? ''} onValue={(v) => set('sa_min', (v || null) as ProductRecord['sa_min'])} /></label>
              <label className="field">Maximum sum assured (optional){aiTag('sa_max')}<AmountInput value={rec.sa_max ?? ''} onValue={(v) => set('sa_max', (v || null) as ProductRecord['sa_max'])} /></label>
              </>}
            </div>
            <fieldset className="field"><legend>{fin ? 'Loan currencies' : 'Policy currencies'}{aiTag('currencies')}{fin && fromDoc.has('currencies') && <span className="pill info tag">From document</span>}</legend>
              <div className="row" style={{ gap: '6px 18px' }}>{(fin ? [...new Set([...FIN_CURRENCIES, ...rec.currencies])] : CURRENCIES).map((c) => (
                <label key={c} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.currencies.includes(c)} onChange={(e) => toggle('currencies', c, e.target.checked)} /> {c}</label>))}</div>
            </fieldset>
            {!fin && <><fieldset className="field"><legend>Who can apply{aiTag('residency')}</legend>
              <div className="row" style={{ gap: '6px 18px' }}>{RESIDENCIES.map((c) => (
                <label key={c} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.residency.includes(c)} onChange={(e) => toggle('residency', c, e.target.checked)} /> {c}</label>))}</div>
            </fieldset>
            <div className="row" style={{ gap: '6px 24px' }}>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.dpi} onChange={(e) => set('dpi', e.target.checked)} /> Direct Purchase Insurance (DPI)</label>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.has_tpd} onChange={(e) => set('has_tpd', e.target.checked)} /> Has TPD cover</label>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rec.has_ci} onChange={(e) => set('has_ci', e.target.checked)} /> Has critical illness cover (built in or rider)</label>
            </div>
            </>}
            <p className="small muted" style={{ margin: 0 }}>{fin ? 'A loan has no entry ages, sum assured or "who can apply": those are left out.' : 'These fields are taken from the Product Summary named below. Compare products uses them to decide which plans fit a client.'}</p>
          </section>

          <section className="card" aria-labelledby="kb-facts">
            <h3 id="kb-facts" className="eyebrow">Product facts (as Compare products shows them)</h3>
            <p className="small muted" style={{ margin: 0 }}>Write each fact as the document says it, and name the page. Leave a fact empty when the document doesn't mention it: Compare products then shows "Not available".
              {rec.product_type ? ` Only the facts a ${planLabel(rec.product_type)} plan has are listed.` : ''}</p>
            <div className="tablewrap">
              <table className="kb-facts">
                <thead><tr><th style={{ width: '24%' }}>Fact</th><th>Value</th><th style={{ width: '26%' }}>Source</th><th style={{ width: 80 }}>Page</th></tr></thead>
                <tbody>
                  {factRows.flatMap((r, i) => {
                    const out = []
                    if (i === 0 || factRows[i - 1].cat !== r.cat) { out.push(<tr key={`c-${r.cat}`} className="cat"><th colSpan={4}>{r.cat}</th></tr>) }
                    const f = rec.facts[r.key]
                    out.push(
                      <tr key={r.key}>
                        <th scope="row">{r.label}{aiSet.has(r.key) ? <span className="pill warn tag" title="Filled by the free AI helper from the document's own words. Check it against the document.">AI</span> : fromDoc.has(r.key) && <span className="pill info tag">From document</span>}</th>
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

          {fin && (
            <section className="card" aria-labelledby="kb-fin-rates">
              <h3 id="kb-fin-rates" className="eyebrow">Cost-of-funds and drawdown rates{fromDoc.has('_fin_rates') && <span className="pill info tag">From document</span>}{finStale && <span className="pill bad tag">Out of date</span>}</h3>
              <p className="small muted" style={{ margin: 0 }}>
                The bank's cost of funds (COF) by currency and tenor, in % a year, with the date it is for; the loan rate is the COF plus the spread above.
                Kind <code>drawdown</code> is an all-in rate with no fixed tenor (tenor 0). One line each, as <code>{FIN_RATES_HEADER}</code>. You can paste from Excel.
              </p>
              <textarea aria-label="Financing rate table (CSV)" rows={8} value={finText} spellCheck={false} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                onChange={(e) => { setFinText(e.target.value); setFinTouched(true) }} />
              <div className="row small" style={{ gap: 12 }}>
                {finParsed.error ? <span className="error">{finParsed.error}</span>
                  : <span className="muted">{fmtNum(finParsed.rates.length)} rate{finParsed.rates.length === 1 ? '' : 's'}{finTouched ? ' (changed, saved when you save)' : ''}</span>}
              </div>
            </section>
          )}
          {!fin && <section className="card" aria-labelledby="kb-rates">
            <h3 id="kb-rates" className="eyebrow">Premium rates (from the rate sheet){fromDoc.has('_rates') && <span className="pill info tag">From document</span>}</h3>
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
                : <span className="muted">{fmtNum(parsed.rates.length)} rate{parsed.rates.length === 1 ? '' : 's'}{ratesTouched ? ' (changed, saved when you save)' : liveRates.length ? ' (in use)' : ''}</span>}
            </div>
          </section>}
        </div>

        <aside className="kb-side">
          <section className="card" aria-label="Save">
            <h3 className="eyebrow">Save</h3>
            <button className="btn primary" onClick={save} disabled={busy || (!dirty && !isNew)}>{busy ? 'Saving…' : 'Save'}</button>
            <span className="small muted">{row?.status === 'withdrawn' ? 'Saved changes apply when the product is put back.' : fin ? 'Saving keeps the record as a new version (earlier versions stay in the history). Premium financing is not offered in Compare products for now.' : 'Saving puts the record in Compare products straight away. No check is needed.'}</span>
            {row?.auto_read && <button className="btn" onClick={() => call('kb_mark_reviewed', { p_id: row.id }, 'Marked as reviewed. The "Auto-read, not yet reviewed" tag is gone.')} disabled={busy || dirty}>Mark as reviewed (no changes)</button>}
            {row?.status === 'verified' && <button className="linkbtn danger" onClick={() => setDialog('withdraw')} disabled={busy}>{fin ? 'Withdraw this record' : 'Withdraw from Compare products'}</button>}
            {row && row.status !== 'verified' && !blocking(row.missing).length && <button className="btn" onClick={() => call('kb_restore_product', { p_id: row.id }, 'Put back. It is in Compare products again.')} disabled={busy}>Put back in Compare products</button>}
            {row && <button className="linkbtn danger" onClick={() => setDialog('delete')} disabled={busy}>Delete this product record</button>}
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
                {history.map((h) => <li key={h.id}>v{plain(h.version)} · {HOW[h.source] ?? 'saved'}{h.changed_by ? ` by ${nameOf(people, h.changed_by)}` : ''}{h.checked_by ? ` · checked by ${nameOf(people, h.checked_by)}` : ''} on {fmtDateTime(h.checked_at)}</li>)}
                {!history.length && <li className="muted">{row.verified_at ? `v${plain(row.version)} (before the history began)` : 'Not saved yet'}</li>}
              </ul>
            </section>
          )}
        </aside>
      </div>

      {upload && <DocDialog mode="new" read={false} docs={docs} products={products} preset={{ doc_type: upload, insurer: rec.insurer.trim(), product_id: row?.id }}
        onClose={() => setUpload(null)} onDone={uploaded} />}
      {dialog === 'delete' && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setDialog(null) }}>
          <div className="card dialog" role="dialog" aria-modal="true" aria-label="Delete this product record" style={{ maxWidth: 480 }}>
            <h2>Delete {row!.name}?</h2>
            <p className="small">The record, its rates and history are deleted and it leaves Compare products. Its documents stay in the Knowledge Bank; PI requests keep the product's name.</p>
            <div className="row dialog-foot" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button className="btn danger" onClick={() => call('kb_delete_product', { p_id: row!.id }, '')}>Delete</button>
            </div>
          </div>
        </div>
      )}
      {dialog === 'withdraw' && <ReasonDialog title="Withdraw from Compare products" confirmLabel="Withdraw" fieldLabel="Reason"
        onCancel={() => setDialog(null)} onConfirm={async (r) => { if (await call('kb_withdraw_product', { p_id: row!.id, p_reason: r }, 'Withdrawn. It no longer appears in Compare products.')) setDialog(null) }} />}
    </main>
  )
}
