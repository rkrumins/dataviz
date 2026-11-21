/**
 * cleanup — what a clean-up does to one value, read in the browser so the What step can show
 * before → after on the values the property holds: the server's rule (`property_job.rewriter`)
 * written again. The server's reading is the one applied — this only previews it, on the values
 * the catalog lists (each element of a list on its own, as the catalog counts them).
 *
 * And the near-duplicates a merge offers: text values that differ only in case or in the spaces
 * around them ("Finance", "finance ", "FINANCE"), grouped as `fold_case(trim(v))` groups them.
 */
import { foldCase } from '@/lib/placement/semantics'
import type { ValueKind, ValueMapping } from '@/services/versioningApiService'
import type { SearchCatalogValue } from '@/types/search'
import type { OpDraft } from './opModel'

export interface Cleaned {
  /** What it becomes (`undefined`: removed, a convert's `onFail: remove`). */
  value: unknown
  kind: string
  /** It is not what it was. */
  changed: boolean
  /** A convert can't make it the kind asked for. */
  fails: boolean
}

const INT_TEXT = /^[+-]?\d+(?:\.0*)?$/
const DEC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)$/
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/** Find & replace on one text, as the server does it: in any case (one character at a time,
 *  `foldCase`) unless `matchCase`, or only a value that is all of `find` with `wholeValue`. */
export function replaceText(op: OpDraft, text: string): string {
  const find = op.find ?? ''
  const to = op.replaceWith ?? ''
  if (!find) return text
  if (op.wholeValue) return (op.matchCase ? text === find : foldCase(text) === foldCase(find)) ? to : text
  if (op.matchCase) return text.split(find).join(to)
  const hay = foldCase(text)
  const needle = foldCase(find)
  let out = ''
  let at = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, at)) {
    out += text.slice(at, i) + to
    at = i + needle.length
  }
  return at === 0 ? text : out + text.slice(at)
}

/** Normalize one text: trimmed, each run of white space one space, in one case. */
export function normalizeText(op: OpDraft, text: string): string {
  let t = text
  if (op.trim ?? true) t = t.trim()
  if (op.collapseSpaces) t = t.replace(/\s+/g, ' ')
  if (op.case === 'lower') t = foldCase(t)
  else if (op.case === 'upper') t = t.toUpperCase()
  else if (op.case === 'title') t = t.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + foldCase(w.slice(1)))
  return t
}

/** One value stored as `toKind`, as the server converts it — or `fails`. */
export function convertValue(value: unknown, kind: string, toKind: ValueKind): { value: unknown; fails: boolean } {
  const ok = (v: unknown) => ({ value: v, fails: false })
  const fail = { value, fails: true }
  if (value === null || typeof value === 'object') return ok(value)
  if (toKind === 'String') {
    if (typeof value === 'boolean') return ok(value ? 'true' : 'false')
    if (typeof value === 'number' && kind === 'Float' && Number.isInteger(value)) return ok(`${value}.0`)
    return ok(String(value))
  }
  if (toKind === 'Boolean') {
    if (typeof value === 'boolean') return ok(value)
    const word = typeof value === 'string' ? foldCase(value.trim()) : null
    return word === 'true' || word === 'false' ? ok(word === 'true') : fail
  }
  if (typeof value === 'boolean') return fail
  if (toKind === 'Integer') {
    if (typeof value === 'number') return Number.isInteger(value) ? ok(value) : fail
    const text = String(value).trim()
    if (!INT_TEXT.test(text)) return fail
    const n = BigInt(text.split('.')[0]!)
    return n < INT64_MIN || n > INT64_MAX ? fail : ok(Number(n))
  }
  if (typeof value === 'number') return kind === 'Integer' && !Number.isSafeInteger(value) ? fail : ok(value)
  const text = String(value).trim()
  const f = DEC_TEXT.test(text) ? Number(text) : NaN
  return Number.isFinite(f) ? ok(f) : fail
}

const slot = (kind: string, value: unknown) => JSON.stringify([kind, value])

/** What a clean-up makes of one value the catalog lists (with the kind it is stored as). */
export function cleanValue(op: OpDraft, value: unknown, kind: string): Cleaned {
  const same = (v: unknown, k = kind): Cleaned => ({ value: v, kind: k, changed: slot(k, v) !== slot(kind, value), fails: false })
  switch (op.kind) {
    case 'replace': return typeof value === 'string' ? same(replaceText(op, value)) : same(value)
    case 'normalize': return typeof value === 'string' ? same(normalizeText(op, value)) : same(value)
    case 'mapValues': {
      const hit = (op.map ?? []).find((m) => slot(m.fromKind ?? kindOf(m.from), m.from) === slot(kind, value))
      return hit ? same(hit.to, hit.toKind ?? kindOf(hit.to)) : same(value)
    }
    case 'convert': {
      if (!op.toKind) return same(value)
      const out = convertValue(value, kind, op.toKind)
      if (out.fails) return op.onFail === 'remove' ? { value: undefined, kind, changed: true, fails: true } : { ...same(value), fails: true }
      return same(out.value, value === null || typeof value === 'object' ? kind : op.toKind)
    }
    default: return same(value)
  }
}

/** The kind a value read from JSON is stored as, as far as JSON can tell (1.0 reads as 1). */
export function kindOf(value: unknown): ValueKind {
  if (typeof value === 'boolean') return 'Boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Float'
  return 'String'
}

/** Values that read as one once case and the spaces around them are set aside — the most held first,
 *  the one it proposes to keep (`canonical`: the most held already written cleanly). */
export interface SimilarGroup {
  key: string
  members: SearchCatalogValue[]
  canonical: number
}

export function similarGroups(values: readonly SearchCatalogValue[]): SimilarGroup[] {
  const by = new Map<string, SearchCatalogValue[]>()
  for (const v of values) {
    if (v.kind !== 'String' || typeof v.value !== 'string') continue
    const key = foldCase(v.value.trim())
    by.set(key, [...(by.get(key) ?? []), v])
  }
  return [...by].filter(([, members]) => members.length > 1).map(([key, members]) => {
    const ranked = [...members].sort((a, b) => b.count - a.count)
    const clean = ranked.findIndex((m) => typeof m.value === 'string' && m.value === m.value.trim())
    return { key, members: ranked, canonical: Math.max(0, clean) }
  }).sort((a, b) => b.members.reduce((n, m) => n + m.count, 0) - a.members.reduce((n, m) => n + m.count, 0))
}

/** A merge of each group into its chosen value. */
export function mergeMap(groups: ReadonlyArray<{ members: readonly SearchCatalogValue[]; canonical: number }>): ValueMapping[] {
  const out: ValueMapping[] = []
  for (const g of groups) {
    const into = g.members[g.canonical]
    if (!into) continue
    for (const m of g.members) {
      if (m === into) continue
      out.push({ from: m.value, fromKind: m.kind as ValueKind, to: into.value, toKind: into.kind as ValueKind })
    }
  }
  return out
}
