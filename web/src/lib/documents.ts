import { supabase } from './supabase'
import { says } from './options'

/** Uploads files to a request and lists them on it. Returns the error messages (empty when all went in). */
export async function uploadDocuments(requestId: string, kind: 'attachment' | 'pi_output', files: File[]) {
  const errors: string[] = []
  for (const file of files) {
    const path = `${requestId}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`
    const up = await supabase.storage.from('request-docs').upload(path, file, { contentType: file.type || 'application/octet-stream' })
    if (up.error) { errors.push(`${file.name}: ${says(up.error.message)}`); continue }
    const ins = await supabase.rpc('add_document', { p_request: requestId, p_kind: kind, p_path: path, p_name: file.name })
    if (ins.error) { errors.push(`${file.name}: ${says(ins.error.message)}`); await supabase.storage.from('request-docs').remove([path]) }
  }
  return errors
}
