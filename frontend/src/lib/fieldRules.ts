/**
 * What an entity type's fields ask of a property's value — its type, its allowed values, whether
 * it is required — as the drawers and the bulk dialog warn while editing. Nothing here blocks an
 * edit: publishing is the gate (the server's `field_violations`, refused as `FieldViolationError`),
 * and these are the same rules, said earlier.
 *
 * Mirrors `backend/app/services/versioning/ontology.py` (`field_value_problem`) and
 * `backend/app/ontology/rules.py` (`field_rules`):
 * - a field's id is the property it is stored as; the name (`name`, `label`) and the reserved node
 *   keys are the platform's to keep, and never judged;
 * - only some types are judged — number, progress, boolean, date, datetime, url, email, tags — and
 *   leniently where the data is: a number or a boolean stored as its text (`"42"`, `"true"`, as a
 *   CSV import keeps it) is one, a date-time field takes a bare date, tags take a list or one text;
 * - allowed values compare as text (`2` is `"2"`, `true` is `"true"`); `allowOther` makes them
 *   suggestions, never a problem;
 * - an empty value (`null`, `''`, `[]`) is no value — only `required` asks for one.
 */
import type { EntityFieldDefinition } from '@/types/schema'
import type { FieldType as InputType } from '@/components/panels/property/fieldTypes'
import { RESERVED_PROPERTY_KEYS } from './nodeFields'

/** Field ids that are the entity's name (`displayName`), not a property. */
const NAME_FIELD_IDS: ReadonlySet<string> = new Set(['name', 'label'])
/** The types a value is judged by. */
const JUDGED: ReadonlySet<string> = new Set(['number', 'progress', 'boolean', 'date', 'datetime', 'url', 'email', 'tags'])
const TYPE_WORDS: Record<string, string> = {
  number: 'a number', progress: 'a number', boolean: 'true or false', date: 'a date (YYYY-MM-DD)',
  datetime: 'a date and time', url: 'a web address', email: 'an email address', tags: 'a list of tags',
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** Allowed values a message names before it says how many more. */
const NAMED = 10

type Field = Pick<EntityFieldDefinition, 'id' | 'name' | 'type' | 'required' | 'allowedValues' | 'allowOther'>

/** Whether the field is a property a publish judges (see the header). */
export function isPropertyField(field: Pick<Field, 'id'>): boolean {
  return !!field.id && !NAME_FIELD_IDS.has(field.id) && !RESERVED_PROPERTY_KEYS.has(field.id)
}

/** The values the field holds its property to — none when it has none, or they are suggestions. */
export function enforcedAllowed(field: Field): readonly string[] {
  return field.allowOther ? [] : field.allowedValues ?? []
}

/** Whether a publish judges the field at all: a property that is required, keeps to allowed
 *  values, or is of a type a value can fail. */
export function isGoverned(field: Field): boolean {
  return isPropertyField(field)
    && (field.required || enforcedAllowed(field).length > 0 || JUDGED.has(String(field.type).toLowerCase()))
}

/** The type's fields a publish judges, by property key. */
export function governedFields(fields: readonly EntityFieldDefinition[] | undefined): ReadonlyMap<string, EntityFieldDefinition> {
  const out = new Map<string, EntityFieldDefinition>()
  for (const f of fields ?? []) if (isGoverned(f) && !out.has(f.id)) out.set(f.id, f)
  return out
}

export const isEmptyValue = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** A scalar as an allowed value names it (the server's `value_text`); null for no value, a list or a group. */
export function valueText(v: unknown): string | null {
  if (v === null || v === undefined || typeof v === 'object') return null
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  const s = String(v).trim()
  return s || null
}

function isNumber(v: unknown): boolean {
  if (typeof v === 'boolean') return false
  if (typeof v === 'number') return Number.isFinite(v)
  const t = String(v).replace(/,/g, '').trim()
  return t !== '' && Number.isFinite(Number(t))
}

function isIso(v: unknown, withTime: boolean): boolean {
  if (typeof v !== 'string') return false
  const t = v.trim()
  if (!DATE_RE.test(t.slice(0, 10)) || Number.isNaN(new Date(t.slice(0, 10)).getTime())) return false
  if (t.length === 10) return true
  return withTime && !Number.isNaN(new Date(t).getTime())
}

function ofType(type: string, v: unknown): boolean {
  switch (type) {
    case 'number': case 'progress': return isNumber(v)
    case 'boolean': return typeof v === 'boolean' || (typeof v === 'string' && ['true', 'false'].includes(v.trim().toLowerCase()))
    case 'tags': return typeof v === 'string' || (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object'))
    case 'date': return isIso(v, false)
    case 'datetime': return isIso(v, true)
    case 'url': return typeof v === 'string' && URI_RE.test(v.trim())
    case 'email': return typeof v === 'string' && EMAIL_RE.test(v.trim())
    default: return true
  }
}

/** The allowed values in a sentence: the first few, and how many more. */
export function allowedPhrase(allowed: readonly string[]): string {
  const named = allowed.slice(0, NAMED).join(', ')
  return allowed.length > NAMED ? `${named} (or ${allowed.length - NAMED} more)` : named
}

/** Why a value breaks the field, in a sentence — or null. An empty value is fine here (see
 *  `requiredMissing`). */
export function fieldProblem(field: Field, value: unknown): string | null {
  if (!isPropertyField(field) || isEmptyValue(value)) return null
  const type = String(field.type).toLowerCase()
  const shown = typeof value === 'string' ? value : JSON.stringify(value)
  if (JUDGED.has(type) && !ofType(type, value)) return `Should be ${TYPE_WORDS[type] ?? type} — “${shown}” isn’t.`
  const allowed = enforcedAllowed(field)
  if (allowed.length > 0) {
    const items = Array.isArray(value) ? value
      : type === 'tags' && typeof value === 'string' ? value.split(',').filter((s) => s.trim()) : [value]
    const bad = items.find((x) => !allowed.includes(valueText(x) ?? ''))
    if (bad !== undefined) return `Must be one of ${allowedPhrase(allowed)} — “${typeof bad === 'string' ? bad.trim() : JSON.stringify(bad)}” isn’t.`
  }
  return null
}

/** A required field without a value. */
export function requiredMissing(field: Field, value: unknown): boolean {
  return isPropertyField(field) && !!field.required && isEmptyValue(value)
}

/** What editing should be told of a value — a problem, or a required field left without one —
 *  in the words of the publish that refuses it; null when there is nothing to say. */
export function fieldWarning(field: Field, value: unknown, typeLabel: string): string | null {
  const problem = fieldProblem(field, value)
  if (problem) return `${problem} Publishing will refuse it.`
  if (requiredMissing(field, value)) {
    return `${field.name || field.id} is required for ${typeLabel} — publishing refuses a new one without it, or one it is emptied on.`
  }
  return null
}

/** The value editor a field's type wants (property/InlineValue's types). */
export function inputTypeOf(type: string | undefined): InputType {
  switch (String(type ?? '').toLowerCase()) {
    case 'number': case 'progress': return 'number'
    case 'boolean': return 'boolean'
    case 'date': return 'date'
    case 'datetime': return 'datetime'
    case 'url': return 'url'
    case 'tags': return 'tags'
    default: return 'text'
  }
}

/** An allowed value (text) as the field stores it: a number field's as a number, a boolean's as
 *  true/false; any other as its text. */
export function storedAllowed(field: Pick<Field, 'type'>, text: string): unknown {
  const type = inputTypeOf(field.type)
  if (type === 'number' && isNumber(text)) return Number(text.replace(/,/g, ''))
  if (type === 'boolean' && ['true', 'false'].includes(text.toLowerCase())) return text.toLowerCase() === 'true'
  return text
}
