/**
 * What a layer rule's propertyMatch / conditions MEAN — the rule-operator
 * slice of backend/common/search_semantics.py, twinned so the placement
 * contract (./placement.ts) compares a stored value exactly as the server's
 * view_placement.py does.
 *
 * The operator table is not restated: arity and value types come from the
 * generated OPERATOR_TABLE, and `value_type: 'auto'` from autoTypeOf. A rule
 * always compares case-insensitively and never includes missing keys, so
 * only that path is twinned. The shared placement corpus
 * (backend/tests/fixtures/placement) pins the two together.
 */
import { autoTypeOf } from '@/components/canvas/search/typed/operators'
import { OPERATOR_TABLE, type PropertyOperator } from '@/types/generated/searchOperators'

/** A value a rule cannot compare the way it asks — worded like the server's. */
export class SemanticsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SemanticsError'
  }
}

/** A rule operator (schema.ts RuleCondition) -> the shared table's operator. */
export const RULE_OPERATORS: Readonly<Record<string, PropertyOperator>> = {
  equals: 'eq',
  notEquals: 'neq',
  contains: 'contains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  exists: 'isSet',
}

/** A rule criterion resolved once: the table operator, the type it compares
 *  as (null for presence) and the user's value — already folded as text. */
export interface Comparison {
  op: PropertyOperator
  type: 'string' | 'number' | 'boolean' | null
  value?: string | number | boolean
}

const INT64_MIN = -(2 ** 63)
const INT64_MAX = 2 ** 63 - 1
const ASCII = /^\p{ASCII}*$/u
// ``toIntegerOrNull`` on text: leading whitespace and a sign, ASCII digits.
const INTEGER_SPELLING = /^[ \t\n\v\f\r]*[+-]?[0-9]+$/

/** search_semantics.fold_case: lower case one character at a time, so 'ΑΣ'
 *  folds to 'ασ' (no final sigma) and 'İ' to 'i'. Not the ontology's
 *  caseFold, which also trims. */
export function foldCase(s: string): string {
  if (ASCII.test(s)) return s.toLowerCase()
  let out = ''
  for (const ch of s) out += ch === 'İ' ? 'i' : ch.toLowerCase()
  return out
}

/** search_semantics.resolve_comparison as a rule calls it: value type auto,
 *  case-insensitive, missing keys excluded. Throws a SemanticsError for an
 *  unknown operator, a missing or non-scalar value, and empty text for a
 *  text operator. */
export function resolveRuleComparison(operator: string, value: unknown): Comparison {
  if (!Object.hasOwn(RULE_OPERATORS, operator)) throw new SemanticsError(`unknown operator '${operator}'`)
  const op = RULE_OPERATORS[operator]
  if (OPERATOR_TABLE[op].arity === 'none') return { op, type: null }
  const v = Array.isArray(value) && value.length === 1 ? value[0] : value
  if (v === null || v === undefined) throw new SemanticsError('enter a value')
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
    throw new SemanticsError(`${JSON.stringify(v)} is not a single value`)
  }
  const type = autoTypeOf(op, v) as 'string' | 'number' | 'boolean'
  if (type === 'number' && !Number.isFinite(v)) throw new SemanticsError(`${v} is not a number`)
  if (type !== 'string') return { op, type, value: v }
  const text = textOf(v) as string
  if (OPERATOR_TABLE[op].types.length === 1 && text === '') throw new SemanticsError('type some text to look for')
  return { op, type, value: foldCase(text) }
}

/** search_semantics.evaluate for a rule comparison; `stored` is null or
 *  undefined for a missing key. A stored list matches when any element does
 *  (notEquals: when none does); a missing key never matches notEquals. */
export function evaluate(stored: unknown, cmp: Comparison): boolean {
  if (cmp.op === 'isSet') return stored != null
  if (cmp.op === 'neq') return stored != null && !matches(stored, 'eq', cmp)
  return matches(stored, cmp.op, cmp)
}

function matches(stored: unknown, op: PropertyOperator, cmp: Comparison): boolean {
  if (!Array.isArray(stored)) return test(keyOf(stored, cmp), op, cmp.value)
  return stored.some((e) => test(keyOf(e, cmp), op, cmp.value))
}

function keyOf(e: unknown, cmp: Comparison): string | number | boolean | null {
  if (cmp.type === 'number') return storedNumber(e)
  if (cmp.type === 'boolean') return storedBoolean(e)
  const text = textOf(e)
  return text === null ? null : foldCase(text)
}

function test(k: string | number | boolean | null, op: PropertyOperator, v: Comparison['value']): boolean {
  if (k === null) return false
  if (op === 'contains') return (k as string).includes(v as string)
  if (op === 'startsWith') return (k as string).startsWith(v as string)
  if (op === 'endsWith') return (k as string).endsWith(v as string)
  return k === v
}

/** search_semantics._text: booleans 'true'/'false', integers their digits,
 *  floats '%.15g', text as is; a nested list or an object has no text. */
function textOf(e: unknown): string | null {
  if (typeof e === 'string') return e
  if (typeof e === 'boolean') return e ? 'true' : 'false'
  if (typeof e === 'number') return Number.isSafeInteger(e) ? String(e) : formatG15(e)
  return null
}

/** C's '%.15g': 15 significant digits rounded half-to-even on the exact
 *  binary value (toPrecision would round a tie up), exponent form when the
 *  exponent is below -4 or from 15, two exponent digits at least, trailing
 *  zeros dropped. toExponential(100) prints the first 101 digits exactly. */
function formatG15(x: number): string {
  const [mantissa, exponent] = x.toExponential(100).split('e')
  const digits = mantissa.replace('-', '').replace('.', '')
  let head = Number(digits.slice(0, 15))
  let exp = Number(exponent)
  const tail = digits.slice(15)
  const half = '5'.padEnd(tail.length, '0')
  if (tail > half || (tail === half && head % 2 === 1)) head += 1
  if (head === 1e15) {
    head = 1e14
    exp += 1
  }
  const sign = x < 0 ? '-' : ''
  const sig = String(head).replace(/0+$/, '')
  if (exp < -4 || exp >= 15) {
    const fraction = sig.length > 1 ? `.${sig.slice(1)}` : ''
    return `${sign}${sig[0]}${fraction}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${sig}`
  if (sig.length <= exp + 1) return sign + sig.padEnd(exp + 1, '0')
  return `${sign}${sig.slice(0, exp + 1)}.${sig.slice(exp + 1)}`
}

/** search_semantics._stored_number: a number as itself (NaN as nothing),
 *  text spelling an integer as it, and 'a.b' as int(a + b) / 10^len(b) — the
 *  server's arithmetic, so both round alike. */
function storedNumber(e: unknown): number | null {
  if (typeof e === 'number') return Number.isNaN(e) ? null : e
  if (typeof e !== 'string') return null
  const parts = e.split('.')
  if (parts.length > 2) return null
  const n = textInteger(parts.join(''))
  if (n === null || parts.length === 1) return n
  // Python's 10.0 ** k; JS `10 ** k` drifts from the exact power past 1e22.
  return n / Number(`1e${parts[1].length}`)
}

function textInteger(s: string): number | null {
  if (!INTEGER_SPELLING.test(s)) return null
  const n = Number(s)
  return n >= INT64_MIN && n <= INT64_MAX ? n : null
}

/** search_semantics._stored_boolean: booleans, and 'true'/'false' text in
 *  any case. */
function storedBoolean(e: unknown): boolean | null {
  if (typeof e === 'boolean') return e
  if (typeof e !== 'string') return null
  const lower = e.toLowerCase()
  return lower === 'true' ? true : lower === 'false' ? false : null
}
