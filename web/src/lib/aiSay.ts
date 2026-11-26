// Wording shared by the AI helper's progress lines (PI comparison, Knowledge Bank).
import { plain } from './num'

/** The live part of a progress line: where the model runs and how far the answer is. */
export function aiHow(p: { device?: string; tokens?: number }): string {
  const where = p.device === 'wasm' ? ', on the processor: this can take several minutes' : ''
  return where + (p.tokens ? `, writing its answer (${plain(p.tokens)} ${p.tokens === 1 ? 'piece' : 'pieces'} so far)` : '')
}
/** "1 min 05 s" for the time a run has taken so far. */
export function aiElapsed(secs: number): string {
  const m = Math.floor(secs / 60), s = secs % 60
  return m ? `${plain(m)} min ${String(s).padStart(2, '0')} s` : `${plain(s)} s`
}
