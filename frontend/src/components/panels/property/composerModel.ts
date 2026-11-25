/**
 * composerModel — what adding a property understands, kept pure so it is tested on its own:
 *
 * - `detectValue`: what a typed value is — a number, yes/no, a date, a moment, a link, or text — so the
 *   value is stored as what it is without anyone picking a type first;
 * - `parsePastedLines`: several properties pasted at once — `name: value`, `name = value`, or a
 *   name and a value separated by a tab (a spreadsheet's two columns) — each detected the same way;
 * - `rankSuggestions`: the names worth offering for what has been typed — what others of this type
 *   carry (most common first), then what this person added recently — never one already there.
 */
import { isIsoDate, isUrl, type FieldType } from './fieldTypes'
import { canonicalInstant, isIsoInstant } from './dateTime'

export interface Detected {
  type: FieldType
  value: unknown
}

/** What a typed value is, and the value to store. Empty stays empty text. */
export function detectValue(text: string): Detected {
  const s = text.trim()
  if (s === '') return { type: 'text', value: '' }
  if (/^(true|yes)$/i.test(s)) return { type: 'boolean', value: true }
  if (/^(false|no)$/i.test(s)) return { type: 'boolean', value: false }
  // A number as people write one — not an id with leading zeros, not a phone number with spaces.
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s.replace(/,(?=\d{3}(\D|$))/g, ''))) {
    return { type: 'number', value: Number(s.replace(/,/g, '')) }
  }
  if (isIsoDate(s)) return { type: 'date', value: s }
  if (isIsoInstant(s)) return { type: 'datetime', value: canonicalInstant(s) }   // stored in UTC
  if (isUrl(s)) return { type: 'url', value: s }
  return { type: 'text', value: text }
}

export interface PastedProperty {
  key: string
  value: unknown
  type: FieldType
}

/** Several properties in one paste. Lines that read as none are skipped; fewer than two read: none. */
export function parsePastedLines(text: string): PastedProperty[] {
  const out: PastedProperty[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^([^\t:=]{1,120}?)\s*(?:\t|:|=)\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const { type, value } = detectValue(m[2])
    out.push({ key, value, type })
  }
  return out.length >= 2 ? out : []
}

/** What others of this entity's type say of a property: how many carry it, an example, its usual type. */
export interface PropertySuggestion {
  key: string
  /** How many other entities of this type carry it — 0 when not counted (a sample's names). */
  count: number
  examples: string[]
  type?: FieldType
}

/** The names to offer for `query`: peers' first (most common), then recent ones; none already there. */
export function rankSuggestions(
  query: string, peers: readonly PropertySuggestion[], recent: readonly string[], existing: readonly string[], limit = 6,
): Array<PropertySuggestion & { recent?: boolean }> {
  const q = query.trim().toLowerCase()
  const taken = new Set(existing)
  const match = (k: string) => !q || k.toLowerCase().includes(q)
  const out: Array<PropertySuggestion & { recent?: boolean }> = []
  const named = new Set<string>()
  // A name that starts with what was typed comes before one that only contains it.
  const starts = (k: string) => (q && k.toLowerCase().startsWith(q) ? 0 : 1)
  for (const p of [...peers].filter((p) => match(p.key) && !taken.has(p.key))
    .sort((a, b) => starts(a.key) - starts(b.key) || b.count - a.count)) {
    out.push(p)
    named.add(p.key)
  }
  for (const k of recent) {
    if (!named.has(k) && !taken.has(k) && match(k)) out.push({ key: k, count: 0, examples: [], recent: true })
  }
  return out.filter((s) => s.key.toLowerCase() !== q || !taken.has(s.key)).slice(0, limit)
}
