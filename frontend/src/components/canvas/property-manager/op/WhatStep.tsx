/**
 * Step 1 — What: the operation, the property it changes (named from every property the view's
 * entities carry, with how many carry it), and its value or new name. A value is typed as what it
 * is — text, a number, yes/no, a date, a link — and the values the property already holds are a
 * click away. A clean-up of the values it holds (find & replace, normalize, merge, convert) is
 * set up with a live before → after (`CleanupFields`).
 */
import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react'
import { ArrowRightLeft, CaseSensitive, Combine, CopyPlus, Eraser, PencilLine, Replace, TextCursorInput, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Segmented } from '@/components/ui/Segmented'
import { AllowedValuePicker, FieldNote } from '@/components/panels/property/FieldGovernance'
import { enforcedAllowed, fieldProblem, governedFields } from '@/lib/fieldRules'
import { useSchemaStore } from '@/store/schema'
import type { EntityFieldDefinition, EntityTypeSchema } from '@/types/schema'
import type { SearchCatalogProperty } from '@/types/search'
import type { PropertyOpKind, ValueKind } from '@/services/versioningApiService'
import { CleanupFields } from './CleanupFields'
import { OP_LABEL, isCleanup, nameProblem, needsTo, needsValue, type OpDraft } from './opModel'
import { FIELD, LABEL } from './styles'

type ValueType = 'text' | 'number' | 'boolean' | 'date' | 'url'

const VALUE_TYPES: Array<{ value: ValueType; label: string }> = [
  { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' }, { value: 'url', label: 'Link' },
]

const KIND_HINT: Record<PropertyOpKind, string> = {
  set: 'Give every entity this value — replacing what it holds.',
  fillEmpty: 'Give this value only to entities without one; the rest keep theirs.',
  rename: 'Move the property to a new name, keeping each value.',
  copy: 'Copy each value to a new property, keeping the original.',
  remove: 'Remove the property from every entity that holds it.',
  replace: 'Find text in its values and put something else in its place.',
  normalize: 'Tidy its text: spaces at either end, runs of spaces, one case — and in lists, each value once.',
  mapValues: 'Merge values that mean the same into one — “Finance”, “finance ” and “FINANCE” become “Finance”.',
  convert: 'Store every value as one kind — the ones that don’t convert are left as they are, or removed.',
}

const OPS: Array<{ group: string; kinds: Array<{ value: PropertyOpKind; icon: ComponentType<{ className?: string }> }> }> = [
  { group: 'Change', kinds: [
    { value: 'set', icon: PencilLine }, { value: 'fillEmpty', icon: Eraser }, { value: 'rename', icon: TextCursorInput },
    { value: 'copy', icon: CopyPlus }, { value: 'remove', icon: Trash2 },
  ] },
  { group: 'Clean up values', kinds: [
    { value: 'replace', icon: Replace }, { value: 'normalize', icon: CaseSensitive }, { value: 'mapValues', icon: Combine },
    { value: 'convert', icon: ArrowRightLeft },
  ] },
]

/** The kind most of a property's entities store it as — what a convert offers first. */
function dominantKind(known: SearchCatalogProperty | null): ValueKind {
  const kinds = Object.entries(known?.kinds ?? {}).filter(([k]) => ['Integer', 'Float', 'String', 'Boolean'].includes(k))
  kinds.sort((a, b) => b[1] - a[1])
  return (kinds[0]?.[0] as ValueKind | undefined) ?? 'String'
}

function typeOfValue(v: unknown): ValueType {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'
  if (typeof v === 'string' && /^https?:\/\//i.test(v)) return 'url'
  return 'text'
}

export function WhatStep({ op, onChange, properties, viewId, edges = false, entityTypes, keySeeded = false }: {
  op: OpDraft
  onChange: (op: OpDraft) => void
  /** Every property the view's entities carry, most carried first. */
  properties: readonly SearchCatalogProperty[]
  /** The view whose values a clean-up previews. */
  viewId: string
  /** It changes relationships: `properties` are the keys the view's relationships carry, uncounted. */
  edges?: boolean
  /** The entity types the target reaches, when known: a field of theirs with allowed values offers
   *  them for the value. */
  entityTypes?: readonly string[]
  /** It was opened with its property named: the focus goes to what is still to give — the new
   *  name, or the value — not to the property. */
  keySeeded?: boolean
}) {
  const set = (patch: Partial<OpDraft>) => onChange({ ...op, ...patch })
  const valueFirst = keySeeded && (needsValue(op.kind) || needsTo(op.kind))
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (valueFirst) root.current?.querySelector<HTMLElement>('#op-to, #op-allowed button, #op-allowed select, #op-value')?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the step opens
  }, [])
  const known = useMemo(() => properties.find((p) => p.key === op.key.trim()) ?? null, [properties, op.key])
  const keyError = op.key ? nameProblem(op.key, edges) : null
  const toError = needsTo(op.kind) && op.to ? (op.to.trim() === op.key.trim() ? 'The new name is the same as the old one' : nameProblem(op.to, edges)) : null
  const toHeldBy = needsTo(op.kind) ? properties.find((p) => p.key === op.to.trim()) : undefined
  // A convert starts from the kind most of its entities hold it as.
  const pick = (kind: PropertyOpKind) => set(kind === 'convert' && !op.toKind ? { kind, toKind: dominantKind(known) } : { kind })
  // A field of the target's types with allowed values: picked from them — only from them when it
  // takes no other. A pick starts the free text again from it.
  const schemaTypes = useSchemaStore((s) => s.schema?.entityTypes)
  const allowedField = useMemo(() => (edges || !needsValue(op.kind) ? null : allowedFieldFor(op.key.trim(), entityTypes, schemaTypes)),
    [edges, op.kind, op.key, entityTypes, schemaTypes])
  const onlyAllowed = !!allowedField && enforcedAllowed(allowedField).length > 0
  const [picks, setPicks] = useState(0)
  // What the property is given, beside it on a wide screen: its value, or its new name.
  const second = needsTo(op.kind) || needsValue(op.kind)

  return (
    <div ref={root} className="space-y-6">
      <div>
        <span className={LABEL} id="op-kind-label">Operation</span>
        <OpPicker value={op.kind} onChange={pick} edges={edges} />
        <p className="mt-2 text-[13px] text-ink-muted">
          {edges ? KIND_HINT[op.kind].replace(/entities/g, 'relationships').replace(/entity/g, 'relationship') : KIND_HINT[op.kind]}
        </p>
      </div>

      <div className={cn('grid gap-5', second && 'md:grid-cols-2')}>
        <div className="min-w-0">
          <label className={LABEL} htmlFor="op-key">Property</label>
          <KeyCombobox id="op-key" value={op.key} onChange={(key) => set({ key })} properties={properties} counted={!edges} autoFocus={!valueFirst} />
          {keyError ? <p role="alert" className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">{keyError}</p>
            : op.key.trim() && (
              <p className="mt-1.5 text-xs text-ink-muted">
                {edges ? (known ? 'The view’s relationships carry it.'
                  : needsValue(op.kind) ? 'A new property — none of the view’s relationships carries it yet.' : 'None of the view’s relationships carries it.')
                  : known
                  ? <>Held by <span className="font-semibold text-ink-secondary tabular-nums">{known.count.toLocaleString()}</span> entities in this view.</>
                  : needsValue(op.kind) ? 'A new property — none of the view’s entities holds it yet.' : 'None of the view’s entities holds it.'}
              </p>
            )}
        </div>

        {second && (
          <div className="min-w-0 space-y-5">
            {needsTo(op.kind) && (
              <div>
                <label className={LABEL} htmlFor="op-to">New name</label>
                <input id="op-to" value={op.to} onChange={(e) => set({ to: e.target.value })} placeholder="e.g. steward"
                  aria-invalid={toError ? true : undefined} className={cn(FIELD, 'font-mono', toError && 'border-rose-500/60')} />
                {toError && <p role="alert" className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">{toError}</p>}
                {toHeldBy && !toError && (
                  <fieldset className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
                    <legend className="px-1 text-xs text-amber-700 dark:text-amber-300">
                      {edges ? 'Some relationships' : `${toHeldBy.count.toLocaleString()} entities`} already hold <span className="font-mono">{op.to.trim()}</span>. For those:
                    </legend>
                    {(['skip', 'overwrite'] as const).map((choice) => (
                      <label key={choice} className="flex items-center gap-2 py-0.5 text-[13px] text-ink">
                        <input type="radio" name="op-conflict" checked={op.onConflict === choice} onChange={() => set({ onConflict: choice })}
                          className="accent-indigo-500" />
                        {choice === 'skip' ? 'Leave them as they are' : `Replace their ${op.to.trim()}`}
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            )}

            {allowedField && (
              <AllowedValues field={allowedField} value={op.value} only={onlyAllowed}
                onPick={(value) => { set({ value: Array.isArray(value) && value.length === 0 ? '' : value }); setPicks((n) => n + 1) }} />
            )}
            {needsValue(op.kind) && !onlyAllowed && <ValueField key={picks} value={op.value} onChange={(value) => set({ value })} known={known} />}
          </div>
        )}
      </div>
      {isCleanup(op.kind) && op.key.trim() && !keyError && (
        <CleanupFields op={op} onChange={set} known={known} viewId={viewId} />
      )}
    </div>
  )
}

/** The field `key` is for the first of `types` that governs it with allowed values. */
function allowedFieldFor(key: string, types: readonly string[] | undefined, schemaTypes: readonly EntityTypeSchema[] | undefined): EntityFieldDefinition | null {
  if (!key) return null
  for (const id of types ?? []) {
    const field = governedFields(schemaTypes?.find((t) => t.id === id)?.fields).get(key)
    if (field?.allowedValues?.length) return field
  }
  return null
}

/** A governed field's allowed values, one click each — said when it takes no other, and when the
 *  value given isn't one. */
function AllowedValues({ field, value, only, onPick }: {
  field: EntityFieldDefinition
  value: unknown
  /** It takes no other value: these stand in for the free text. */
  only: boolean
  onPick: (value: unknown) => void
}) {
  const name = field.name || field.id
  const problem = fieldProblem(field, value)
  return (
    <div id="op-allowed">
      <span className={LABEL}>{only ? 'Value' : 'Suggested values'}</span>
      <AllowedValuePicker field={field} value={value} label={name} onPick={onPick} />
      {problem ? <FieldNote className="mt-1.5">{problem} Publishing will refuse it.</FieldNote>
        : only && <p className="mt-1.5 text-xs text-ink-muted">{name} takes only these values — publishing refuses any other.</p>}
    </div>
  )
}

/** The operation: a change of the property, or a clean-up of its values — one choice, in two rows.
 *  A radiogroup: one tab stop, arrow keys move the choice. A relationship's values aren't
 *  catalogued, so its clean-ups (which preview them) aren't offered. */
function OpPicker({ value, onChange, edges }: { value: PropertyOpKind; onChange: (kind: PropertyOpKind) => void; edges: boolean }) {
  const groups = edges ? OPS.slice(0, 1) : OPS
  const all = groups.flatMap((g) => g.kinds.map((k) => k.value))
  const refs = useRef(new Map<PropertyOpKind, HTMLButtonElement | null>())
  const move = (e: KeyboardEvent, from: PropertyOpKind) => {
    const at = all.indexOf(from)
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? all[(at + 1) % all.length]
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? all[(at - 1 + all.length) % all.length]
        : e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1] : undefined
    if (!to) return
    e.preventDefault()
    onChange(to)
    refs.current.get(to)?.focus()
  }
  return (
    <div role="radiogroup" aria-labelledby="op-kind-label" className="space-y-2">
      {groups.map((g) => (
        <div key={g.group} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <span className="shrink-0 text-xs text-ink-muted sm:w-28">{g.group}</span>
          <div className="inline-flex flex-wrap items-center gap-0.5 self-start rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.05]">
            {g.kinds.map(({ value: kind, icon: Icon }) => {
              const on = kind === value
              return (
                <button key={kind} ref={(el) => { refs.current.set(kind, el) }} type="button" role="radio" aria-checked={on}
                  tabIndex={on ? 0 : -1} onClick={() => onChange(kind)} onKeyDown={(e) => move(e, kind)}
                  className={cn('inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    on ? 'bg-canvas-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink')}>
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  {OP_LABEL[kind]}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** A property's name, offered from every property the view carries — most carried first. */
function KeyCombobox({ id, value, onChange, properties, counted = true, autoFocus = true }: {
  id: string
  value: string
  onChange: (key: string) => void
  properties: readonly SearchCatalogProperty[]
  /** Each property's count is how many hold it. */
  counted?: boolean
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const q = value.trim().toLowerCase()
  const offered = useMemo(
    () => properties.filter((p) => !q || p.key.toLowerCase().includes(q)).slice(0, 8),
    [properties, q],
  )
  const show = open && offered.length > 0 && !(offered.length === 1 && offered[0]!.key === value.trim())
  const pick = (key: string) => { onChange(key); setOpen(false) }
  return (
    <div className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={show}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        autoFocus={autoFocus}
        value={value}
        placeholder="e.g. owner, certified, retentionDays"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0) }}
        onKeyDown={(e) => {
          if (!show) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, offered.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter' && offered[active]) { e.preventDefault(); e.stopPropagation(); pick(offered[active]!.key) }
          else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
        }}
        className={cn(FIELD, 'font-mono')}
      />
      {show && (
        <ul id={`${id}-list`} role="listbox" aria-label="Properties in this view"
          className="absolute z-10 mt-1 w-full max-h-52 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border bg-canvas-elevated p-1 shadow-lg">
          {offered.map((p, i) => (
            <li key={p.key} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(p.key) }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex items-center gap-2 px-2.5 h-9 rounded-md cursor-pointer text-[13px]', i === active ? 'bg-accent-lineage/10 text-ink' : 'text-ink-secondary')}>
              <span className="flex-1 min-w-0 truncate font-mono">{p.key}</span>
              {counted && <span className="text-[11px] tabular-nums text-ink-muted">{p.count.toLocaleString()}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The value, typed as what it is — and the values the property already holds, a click away. */
function ValueField({ value, onChange, known }: {
  value: unknown
  onChange: (value: unknown) => void
  known: SearchCatalogProperty | null
}) {
  const [type, setType] = useState<ValueType>(() => (value !== undefined && value !== '' ? typeOfValue(value) : 'text'))
  const [text, setText] = useState(() => (value === undefined || value === null ? '' : String(value)))
  const commitText = (t: ValueType, raw: string) => {
    setText(raw)
    if (t === 'number') {
      const n = Number(raw.replace(/,/g, ''))
      onChange(raw.trim() === '' || !Number.isFinite(n) ? '' : n)
    } else onChange(raw)
  }
  const changeType = (t: ValueType) => {
    setType(t)
    if (t === 'boolean') onChange(typeof value === 'boolean' ? value : true)
    else commitText(t, text)
  }
  const numberBad = type === 'number' && text.trim() !== '' && !Number.isFinite(Number(text.replace(/,/g, '')))
  const existing = (known?.values ?? []).slice(0, 8)
  return (
    <div>
      <span className={LABEL}>Value</span>
      <div className="flex items-start gap-2">
        <select aria-label="Kind of value" value={type} onChange={(e) => changeType(e.target.value as ValueType)}
          className={cn(FIELD, 'w-32 shrink-0 px-2')}>
          {VALUE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {type === 'boolean' ? (
          <Segmented<'yes' | 'no'>
            label="Value"
            size="md"
            value={value === false ? 'no' : 'yes'}
            onChange={(v) => onChange(v === 'yes')}
            options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
          />
        ) : (
          <div className="flex-1 min-w-0">
            <input
              id="op-value"
              aria-label="Value"
              type={type === 'date' ? 'date' : type === 'url' ? 'url' : 'text'}
              inputMode={type === 'number' ? 'decimal' : undefined}
              value={text}
              onChange={(e) => commitText(type, e.target.value)}
              placeholder={type === 'number' ? '0' : type === 'url' ? 'https://…' : 'value…'}
              aria-invalid={numberBad ? true : undefined}
              className={cn(FIELD, (type === 'number' || type === 'text') && 'font-mono', numberBad && 'border-rose-500/60',
                type === 'date' && '[color-scheme:light] dark:[color-scheme:dark]')}
            />
            {numberBad && <p role="alert" className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">“{text.trim()}” isn’t a number</p>}
          </div>
        )}
      </div>
      {existing.length > 0 && type !== 'boolean' && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-ink-muted mr-0.5">It holds:</span>
          {existing.map((v) => (
            <button key={`${v.kind}:${String(v.value)}`} type="button"
              onClick={() => { const t = typeOfValue(v.value); setType(t); commitText(t, String(v.value)) }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary hover:bg-accent-lineage/10 hover:text-accent-lineage transition-colors">
              {String(v.value) || '∅'}
              <span className="tabular-nums text-ink-muted">{v.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
