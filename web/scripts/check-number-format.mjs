// Kumar (25 Nov 2026): every number on the website shows a comma at each thousand (1,000,000).
// This check fails the build when a number-typed value is put into on-screen text without going
// through the shared formatter in src/lib/num.ts (fmtNum, fmtMoney, ...). It uses the TypeScript
// type checker, so it finds numbers however they are named.
//
// Allowed without formatting: values that can never reach 1,000 or are not quantities
// (years, ids, page numbers, reference numbers) when written as plain(x) from src/lib/num.ts,
// and template strings used for keys, ids, CSS, URLs and file names (attributes listed below).
import ts from 'typescript-api'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfgPath = path.join(root, 'tsconfig.app.json')
const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
const program = ts.createProgram(cfg.fileNames, { ...cfg.options, noEmit: true })
const checker = program.getTypeChecker()

/** JSX attributes that are not shown to people. */
const NOT_SHOWN = new Set(['key', 'id', 'htmlFor', 'className', 'style', 'to', 'href', 'src', 'name', 'form', 'list', 'download', 'value', 'min', 'max', 'step', 'width', 'height', 'colSpan', 'rowSpan', 'tabIndex', 'data-field', 'data-testid'])
/** Calls whose string arguments are not shown to people. */
const NOT_SHOWN_CALLS = /^(?:console\.\w+|navigate|setSearchParams|URLSearchParams|querySelector|querySelectorAll|getElementById|from|storage\.\w+|\w+\.from|\w+\.rpc|\w+\.eq|\w+\.in|\w+\.or|\w+\.select|\w+\.upload|\w+\.remove|\w+\.download|\w+\.createSignedUrl|fetch|new URL|localStorage\.\w+|sessionStorage\.\w+|\w+\.setItem|\w+\.getItem|scrollIntoView|\w+\.toISOString|Date|new Date|\w+\.padStart)$/

const NUM = ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike
const EMPTY = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.BooleanLike | ts.TypeFlags.Void
/** A number (or a number that may be missing). Not ReactNode and other mixes that only may hold a number. */
const isNumberType = (t) => {
  if (t.isUnion()) return t.types.some((x) => x.flags & NUM) && t.types.every((x) => x.flags & (NUM | EMPTY))
  return !!(t.flags & NUM)
}

const problems = []
const found = []
const fmtFile = path.join(root, 'src/lib/num.ts')

function attrName(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return p.name.getText()
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p) || ts.isFunctionLike(p)) return null
  }
  return null
}
function callName(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const e = p.expression.getText()
      return ts.isNewExpression(p) ? `new ${e}` : e
    }
    if (ts.isStatement(p) || ts.isJsxAttribute(p) || ts.isJsxElement(p) || ts.isFunctionLike(p)) return null
  }
  return null
}
/** n.toFixed(2) or String(n): a number turned into text without commas. */
const isBareNumberText = (e) => ts.isCallExpression(e) && (
  (ts.isPropertyAccessExpression(e.expression) && ['toFixed', 'toString', 'toPrecision'].includes(e.expression.name.text) && isNumberType(checker.getTypeAtLocation(e.expression.expression)))
  || (ts.isIdentifier(e.expression) && e.expression.text === 'String' && e.arguments.length === 1 && isNumberType(checker.getTypeAtLocation(e.arguments[0]))))
const needsFormat = (e) => isNumberType(checker.getTypeAtLocation(e)) || isBareNumberText(e)

/** The parts of an expression that end up in the text: a && b -> b, c ? a : b -> a, b. */
function shownParts(e) {
  while (ts.isParenthesizedExpression(e)) e = e.expression
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) return shownParts(e.right)
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return [...shownParts(e.left), ...shownParts(e.right)]
  if (ts.isConditionalExpression(e)) return [...shownParts(e.whenTrue), ...shownParts(e.whenFalse)]
  return [e]
}
function report(sf, node, why) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart())
  problems.push(`${path.relative(root, sf.fileName)}:${line + 1}:${character + 1}  ${why}: ${node.getText().slice(0, 80)}`)
  found.push({ file: sf.fileName, start: node.getStart(), end: node.getEnd(), line: line + 1, text: node.getText(), why })
}

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !sf.fileName.startsWith(path.join(root, 'src')) || sf.fileName === fmtFile) continue
  if (/ocr|Worker/i.test(path.basename(sf.fileName))) continue
  const visit = (node) => {
    // {count} as text in JSX
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const part of shownParts(node.expression)) if (needsFormat(part)) report(sf, part, 'number shown without fmtNum()')
    }
    // `${count} files` in text that people read
    if (ts.isTemplateSpan(node)) {
      const a = attrName(node)
      const c = callName(node)
      const tpl = node.parent
      const shown = !(a && NOT_SHOWN.has(a)) && !(c && NOT_SHOWN_CALLS.test(c)) && !ts.isTaggedTemplateExpression(tpl.parent)
      if (shown) for (const part of shownParts(node.expression)) if (needsFormat(part)) report(sf, part, 'number in text without fmtNum()')
    }
    // n.toLocaleString() writes numbers its own way: use fmtNum so every page looks the same
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toLocaleString'
      && isNumberType(checker.getTypeAtLocation(node.expression.expression))) report(sf, node, 'use fmtNum() instead of toLocaleString()')
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

if (process.env.CHECK_JSON) { console.log(JSON.stringify(found)); process.exit(0) }
if (problems.length) {
  console.error(`Numbers must show thousands commas (use fmtNum / fmtMoney from src/lib/num.ts, or plain() for years, ids and page numbers):\n${problems.join('\n')}`)
  process.exit(1)
}
console.log('Number format check: every number shown on screen goes through the shared formatter.')
