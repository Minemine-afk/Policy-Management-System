// Checks that client particulars missing from a PI are filled from the request form (web/src/lib/formFill.ts).
// Usage: node tests/pi-extract/check-form-fill.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const { fillFromForm, isFromForm } = await import(path.join(here, '../../web/src/lib/formFill.ts'))
const { headerValue } = await import(path.join(here, '../../web/src/lib/piExcel.ts'))

let pass = 0, fail = 0
const check = (what, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`✗ ${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`) } }
const pi = (v) => ({ found: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { value: x, page: x ? 1 : null, line: x ? 'pi' : null }])), values: v })

// Nothing in the PI: everything the form has is filled, the name from the gender
let r = fillFromForm(...Object.values(pi({ insured_name: '', gender: '', underwriting_class: '', date_of_birth: '' })), { gender: 'Female', smoker: true, age_band: '30 to 34' })
check('gender', r.values.gender, 'Female'); check('smoker', r.values.underwriting_class, 'Smoker'); check('name', r.values.insured_name, 'Mrs VIP')
check('marked', ['gender', 'underwriting_class', 'insured_name'].map((k) => isFromForm(r.found[k])), [true, true, true])
check('age band note', r.notes, ['Client age band on the request form: 30 to 34.'])
r = fillFromForm(...Object.values(pi({ insured_name: '', gender: '', underwriting_class: '', date_of_birth: '' })), { gender: 'Male', smoker: false, age_band: '' })
check('male name', r.values.insured_name, 'Mr VIP'); check('non-smoker', r.values.underwriting_class, 'Non-Smoker')

// The PI wins; a different form value only adds a note
r = fillFromForm(...Object.values(pi({ insured_name: 'Mr Tan', gender: 'Female', underwriting_class: 'Non-Smoker', date_of_birth: '01/01/1990' })), { gender: 'Male', smoker: true, age_band: '30 to 34' })
check('PI kept', [r.values.insured_name, r.values.gender, r.values.underwriting_class], ['Mr Tan', 'Female', 'Non-Smoker'])
check('not marked', isFromForm(r.found.gender), false)
check('mismatch notes', r.notes, ['The PI says Female, but the request form says Male.', 'The PI says Non-Smoker, but the request form says Smoker.'])
// Name from the PI's gender when the PI has gender but no name
r = fillFromForm(...Object.values(pi({ insured_name: '', gender: 'Female', underwriting_class: '', date_of_birth: '' })), { gender: 'Male', smoker: false, age_band: '' })
check('name follows PI gender', r.values.insured_name, 'Mrs VIP')

// The header prefers a PI's own value over a form value
const cols = [
  { values: { gender: 'Male' }, fromForm: { gender: true } },
  { values: { gender: 'Female' }, fromForm: {} },
]
check('header prefers PI', headerValue(cols, 'gender'), { value: 'Female', fromForm: false, differs: [] })
check('header from form', headerValue([cols[0]], 'gender'), { value: 'Male', fromForm: true, differs: [] })

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
