import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { KbDocument } from '../lib/types'
import { openKbDocument } from '../pages/KnowledgeBank'

/** Knowledge-bank documents whose tags match the categories picked on the form. */
export default function RelevantDocs({ tags }: { tags: string[] }) {
  const [docs, setDocs] = useState<KbDocument[]>([])
  const key = tags.join(',')
  useEffect(() => {
    if (!tags.length) { setDocs([]); return }
    supabase.from('kb_documents').select('*').overlaps('tags', tags).eq('archived', false)
      .order('doc_type').limit(8).then(({ data }) => setDocs((data as KbDocument[]) ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <section className="card" aria-labelledby="rel-head">
      <h2 id="rel-head" className="eyebrow">Relevant documents</h2>
      {docs.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nothing tagged for these categories yet.</p>}
      <ul className="filelist">
        {docs.map((d) => (
          <li key={d.id}>
            <div>
              <div style={{ fontWeight: 500 }}>{d.title}</div>
              <div className="small muted">{d.doc_type}{d.insurer ? ` · ${d.insurer}` : ''}</div>
            </div>
            {d.storage_path
              ? <button className="linkbtn" onClick={() => openKbDocument(d)}>Open</button>
              : <a href={`/knowledge?doc=${d.id}`}>View</a>}
          </li>
        ))}
      </ul>
    </section>
  )
}
