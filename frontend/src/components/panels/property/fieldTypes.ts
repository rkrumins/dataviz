/**
 * Friendly, business-facing field types for the property editor.
 *
 * These are a PRESENTATION/INPUT layer over the flat `string → JSON value` map.
 * Nothing here is persisted: the type is inferred from the stored JSON value on
 * read (`inferFieldType`), and each type maps back to a plain JSON kind so values
 * always round-trip cleanly to the backend.
 */

import {
  Type as TypeIcon,
  Hash,
  ToggleLeft,
  Calendar,
  Link2,
  Tags as TagsIcon,
  Braces,
  Brackets,
  CircleDashed,
} from 'lucide-react'

export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'url'
  | 'tags'
  | 'list'
  | 'group'
  | 'none'

/** The underlying JSON kind a value is stored as. */
export type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

export interface FieldTypeMeta {
  type: FieldType
  label: string
  hint: string
  icon: typeof TypeIcon
  /** Tailwind tone for the chip (text + subtle bg). */
  tone: string
  jsonKind: JsonKind
}

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  text: { type: 'text', label: 'Text', hint: 'Words, descriptions, Markdown', icon: TypeIcon, tone: 'text-blue-500 bg-blue-500/10', jsonKind: 'string' },
  number: { type: 'number', label: 'Number', hint: 'Numeric value', icon: Hash, tone: 'text-purple-500 bg-purple-500/10', jsonKind: 'number' },
  boolean: { type: 'boolean', label: 'Yes / No', hint: 'A true or false flag', icon: ToggleLeft, tone: 'text-amber-500 bg-amber-500/10', jsonKind: 'boolean' },
  date: { type: 'date', label: 'Date', hint: 'A calendar date', icon: Calendar, tone: 'text-rose-500 bg-rose-500/10', jsonKind: 'string' },
  url: { type: 'url', label: 'Link', hint: 'A web address', icon: Link2, tone: 'text-sky-500 bg-sky-500/10', jsonKind: 'string' },
  tags: { type: 'tags', label: 'Tags', hint: 'A list of labels', icon: TagsIcon, tone: 'text-cyan-500 bg-cyan-500/10', jsonKind: 'array' },
  list: { type: 'list', label: 'List', hint: 'A list of values', icon: Brackets, tone: 'text-cyan-500 bg-cyan-500/10', jsonKind: 'array' },
  group: { type: 'group', label: 'Group', hint: 'Nested properties', icon: Braces, tone: 'text-emerald-500 bg-emerald-500/10', jsonKind: 'object' },
  none: { type: 'none', label: 'Empty', hint: 'No value', icon: CircleDashed, tone: 'text-ink-muted bg-white/5', jsonKind: 'null' },
}

/** Friendly types offered up-front in menus. */
export const COMMON_TYPES: FieldType[] = ['text', 'number', 'boolean', 'date', 'url', 'tags', 'group']
/** Power-user types tucked behind an "Advanced" divider. */
export const ADVANCED_TYPES: FieldType[] = ['list', 'none']

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const URL_RE = /^https?:\/\/[^\s]+$/i

export function isIsoDate(v: string): boolean {
  if (!ISO_DATE_RE.test(v)) return false
  const d = new Date(v)
  return !Number.isNaN(d.getTime())
}

export function isUrl(v: string): boolean {
  return URL_RE.test(v.trim())
}

/** Infer the friendly field type from a stored JSON value. */
export function inferFieldType(value: unknown): FieldType {
  if (value === null || value === undefined) return 'none'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) {
    return value.every((x) => typeof x === 'string') ? 'tags' : 'list'
  }
  if (typeof value === 'object') return 'group'
  // string
  const s = String(value)
  if (isIsoDate(s)) return 'date'
  if (isUrl(s)) return 'url'
  return 'text'
}

/** The default (empty) value to store when a type is first chosen. */
export function valueForType(type: FieldType): unknown {
  switch (type) {
    case 'text':
    case 'url':
      return ''
    case 'date':
      return new Date().toISOString().slice(0, 10) // today, YYYY-MM-DD
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'tags':
    case 'list':
      return []
    case 'group':
      return {}
    case 'none':
      return null
  }
}

/**
 * Coerce an existing value into a new field type, preserving information where
 * sensible. Used when the user changes a property's type.
 */
export function coerceToType(value: unknown, type: FieldType): unknown {
  switch (type) {
    case 'text':
    case 'url':
      if (value === null || value === undefined) return ''
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    case 'date': {
      if (typeof value === 'string' && isIsoDate(value)) return value
      const d = new Date(typeof value === 'string' || typeof value === 'number' ? value : Date.now())
      return Number.isNaN(d.getTime()) ? valueForType('date') : d.toISOString().slice(0, 10)
    }
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : 0
    }
    case 'boolean':
      if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1'
      return Boolean(value)
    case 'tags': {
      if (Array.isArray(value)) return value.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
      if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean)
      return []
    }
    case 'list':
      return Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]
    case 'group':
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
    case 'none':
      return null
  }
}

/**
 * Guard: returns true if `value` is plain JSON (serializable, no undefined / NaN /
 * Infinity / class instances / functions). Used to guarantee values persist.
 */
export function isJsonSafe(value: unknown): boolean {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value as number)
  if (Array.isArray(value)) return value.every(isJsonSafe)
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false // reject class instances (Date, Map, …)
    return Object.values(value as Record<string, unknown>).every(isJsonSafe)
  }
  return false // function, symbol, undefined, bigint
}
