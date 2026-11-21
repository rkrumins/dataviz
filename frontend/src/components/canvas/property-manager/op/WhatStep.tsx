/**
 * Step 1 — What: the operation, the property it changes (named from every property the view's
 * entities carry, with how many carry it), and its value or new name. A value is typed as what it
 * is — text, a number, yes/no, a date, a link — and the values the property already holds are a
 * click away.
 */
import { useMemo, useState } from 'react'
import { CopyPlus, Eraser, PencilLine, TextCursorInput, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Segmented } from '@/components/ui/Segmented'
import type { SearchCatalogProperty } from '@/types/search'
import type { PropertyOpKind } from '@/services/versioningApiService'
import { OP_LABEL, nameProblem, needsTo, needsValue, type OpDraft } from './opModel'
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
}

function typeOfValue(v: unknown): ValueType {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'
  if (typeof v === 'string' && /^https?:\/\//i.test(v)) return 'url'
  return 'text'
}

export function WhatStep({ op, onChange, properties, edges = false }: {
  op: OpDraft
  onChange: (op: OpDraft) => void
  /** Every property the view's entities carry, most carried first. */
  properties: readonly SearchCatalogProperty[]
  /** It changes relationships: `properties` are the keys the view's relationships carry, uncounted. */
  edges?: boolean
}) {
  const set = (patch: Partial<OpDraft>) => onChange({ ...op, ...patch })
  const known = useMemo(() => properties.find((p) => p.key === op.key.trim()) ?? null, [properties, op.key])
  const keyError = op.key ? nameProblem(op.key, edges) : null
  const toError = needsTo(op.kind) && op.to ? (op.to.trim() === op.key.trim() ? 'The new name is the same as the old one' : nameProblem(op.to, edges)) : null
  const toHeldBy = needsTo(op.kind) ? properties.find((p) => p.key === op.to.trim()) : undefined

  return (
    <div className="space-y-5">
      <div>
        <span className={LABEL}>Operation</span>
        <Segmented<PropertyOpKind>
          label="Operation"
          size="md"
          value={op.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: 'set', label: OP_LABEL.set, icon: PencilLine },
            { value: 'fillEmpty', label: OP_LABEL.fillEmpty, icon: Eraser },
            { value: 'rename', label: OP_LABEL.rename, icon: TextCursorInput },
            { value: 'copy', label: OP_LABEL.copy, icon: CopyPlus },
            { value: 'remove', label: OP_LABEL.remove, icon: Trash2 },
          ]}
        />
        <p className="mt-1.5 text-[11.5px] text-ink-muted">
          {edges ? KIND_HINT[op.kind].replace(/entities/g, 'relationships').replace(/entity/g, 'relationship') : KIND_HINT[op.kind]}
        </p>
      </div>

      <div>
        <label className={LABEL} htmlFor="op-key">Property</label>
        <KeyCombobox id="op-key" value={op.key} onChange={(key) => set({ key })} properties={properties} counted={!edges} />
        {keyError ? <p role="alert" className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">{keyError}</p>
          : op.key.trim() && (
            <p className="mt-1 text-[11px] text-ink-muted">
              {edges ? (known ? 'The view’s relationships carry it.'
                : needsValue(op.kind) ? 'A new property — none of the view’s relationships carries it yet.' : 'None of the view’s relationships carries it.')
                : known
                ? <>Held by <span className="font-semibold text-ink-secondary tabular-nums">{known.count.toLocaleString()}</span> entities in this view.</>
                : needsValue(op.kind) ? 'A new property — none of the view’s entities holds it yet.' : 'None of the view’s entities holds it.'}
            </p>
          )}
      </div>

      {needsTo(op.kind) && (
        <div>
          <label className={LABEL} htmlFor="op-to">New name</label>
          <input id="op-to" value={op.to} onChange={(e) => set({ to: e.target.value })} placeholder="e.g. steward"
            aria-invalid={toError ? true : undefined} className={cn(FIELD, 'font-mono', toError && 'border-rose-500/60')} />
          {toError && <p role="alert" className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">{toError}</p>}
          {toHeldBy && !toError && (
            <fieldset className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
              <legend className="px-1 text-[11px] text-amber-700 dark:text-amber-300">
                {edges ? 'Some relationships' : `${toHeldBy.count.toLocaleString()} entities`} already hold <span className="font-mono">{op.to.trim()}</span>. For those:
              </legend>
              {(['skip', 'overwrite'] as const).map((choice) => (
                <label key={choice} className="flex items-center gap-2 py-0.5 text-[12px] text-ink">
                  <input type="radio" name="op-conflict" checked={op.onConflict === choice} onChange={() => set({ onConflict: choice })}
                    className="accent-indigo-500" />
                  {choice === 'skip' ? 'Leave them as they are' : `Replace their ${op.to.trim()}`}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      )}

      {needsValue(op.kind) && <ValueField value={op.value} onChange={(value) => set({ value })} known={known} />}
    </div>
  )
}

/** A property's name, offered from every property the view carries — most carried first. */
function KeyCombobox({ id, value, onChange, properties, counted = true }: {
  id: string
  value: string
  onChange: (key: string) => void
  properties: readonly SearchCatalogProperty[]
  /** Each property's count is how many hold it. */
  counted?: boolean
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
        autoFocus
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
          className="absolute z-10 mt-1 w-full max-h-64 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border bg-canvas-elevated p-1 shadow-lg">
          {offered.map((p, i) => (
            <li key={p.key} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(p.key) }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex items-center gap-2 px-2 h-8 rounded-md cursor-pointer text-[12px]', i === active ? 'bg-accent-lineage/10 text-ink' : 'text-ink-secondary')}>
              <span className="flex-1 min-w-0 truncate font-mono">{p.key}</span>
              {counted && <span className="text-[10.5px] tabular-nums text-ink-muted">{p.count.toLocaleString()}</span>}
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
            {numberBad && <p role="alert" className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">“{text.trim()}” isn’t a number</p>}
          </div>
        )}
      </div>
      {existing.length > 0 && type !== 'boolean' && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[10.5px] text-ink-muted mr-0.5">It holds:</span>
          {existing.map((v) => (
            <button key={`${v.kind}:${String(v.value)}`} type="button"
              onClick={() => { const t = typeOfValue(v.value); setType(t); commitText(t, String(v.value)) }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-mono bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary hover:bg-accent-lineage/10 hover:text-accent-lineage transition-colors">
              {String(v.value) || '∅'}
              <span className="tabular-nums text-ink-muted">{v.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
