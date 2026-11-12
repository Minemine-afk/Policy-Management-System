// Client particulars the PI does not show are filled from the introducer's request form (Kumar, 12 Nov 2026).
// Only the profile fields ops and bsd can already see on the request are used: gender, smoker and age band.
// The client's real name is never used (only the introducer can see it); like the PIs themselves, the name
// becomes "Mr VIP" or "Mrs VIP" from the gender. The form has no date of birth or residency.
import type { Found } from './piExtract.ts'

export interface FormProfile { gender: string; smoker: boolean; age_band: string }

/** Marks a value that came from the request form, not the PI (the "line" of a Found). */
export const FROM_FORM = 'From the request form'
export const isFromForm = (f: Found | undefined) => f?.line === FROM_FORM

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '')

export function fillFromForm(found: Record<string, Found>, values: Record<string, string>, form: FormProfile) {
  const f = { ...found }, v = { ...values }, notes: string[] = []
  const put = (k: string, value: string) => { f[k] = { value, page: null, line: FROM_FORM }; v[k] = value }
  const blank = (k: string) => !(v[k] ?? '').trim()
  const formSmoker = form.smoker ? 'Smoker' : 'Non-Smoker'

  if (blank('gender') && form.gender) put('gender', form.gender)
  else if (form.gender && norm(v.gender) !== norm(form.gender)) notes.push(`The PI says ${v.gender}, but the request form says ${form.gender}.`)
  if (blank('underwriting_class')) put('underwriting_class', formSmoker)
  else if (/smok/i.test(v.underwriting_class) && norm(v.underwriting_class) !== norm(formSmoker)) notes.push(`The PI says ${v.underwriting_class}, but the request form says ${formSmoker}.`)
  if (blank('insured_name')) {
    const g = (v.gender ?? '').trim().toLowerCase()
    if (g === 'male' || g === 'female') put('insured_name', g === 'male' ? 'Mr VIP' : 'Mrs VIP')
  }
  if (blank('date_of_birth') && form.age_band) notes.push(`Client age band on the request form: ${form.age_band}.`)
  return { found: f, values: v, notes }
}
