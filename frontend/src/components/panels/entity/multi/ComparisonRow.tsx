/**
 * ComparisonRow — one property across several entities: whether they hold it alike, how they
 * differ, and the change pending for all of them. Opening the row (its name, or → / Enter) shows
 * every value it holds and who holds each one.
 *
 * In a draft, the value is edited where it is read — a value typed here is set on all of them —
 * and the row offers the rest: fill where missing, rename, copy to a new name, remove from all.
 * One change is pending per property; choosing another replaces it, and ↺ takes it back.
 *
 * A field of the entities' type (`rule`) offers its allowed values with one click, and a change
 * publishing would refuse — a value it doesn't allow, a required one removed — is warned of under
 * the row. It is still staged: the publish is the gate. A required one some of them lack offers to
 * fill it on every entity of the type missing it, from the bulk dialog.
 */
import { memo, useState, type KeyboardEvent } from 'react'
import { motion } from 'framer-motion'
import { Check, ChevronRight, Copy, CopyPlus, PencilLine, RotateCcw, TextCursorInput, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { RESERVED_PROPERTY_KEYS } from '@/lib/nodeFields'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import type { SharedField } from '@/components/canvas/context-view/bulkEdit'
import { fieldWarning } from '@/lib/fieldRules'
import type { EntityFieldDefinition } from '@/types/schema'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { fillRequiredConnectionsRequest, fillRequiredRequest } from '@/components/canvas/property-manager/op/fillRequired'
import { InlineValue } from '../../property/InlineValue'
import { AllowedValuePicker, FieldNote, FillMissingButton } from '../../property/FieldGovernance'
import { RichValue } from '../../property/RichValue'
import type { FieldType } from '../../property/fieldTypes'
import type { KeyChange } from './editOps'
import { ValueBreakdown, type Member } from './ValueBreakdown'
import { OTHER_TONE, toneOf } from './tones'

const NAME_MAX = 128

/** A field a publish judges, and the entities' type as its warnings name it ("Tables") — and by its
 *  id and name, as a fill of every one missing it names it. `edges`: a relationship type's field. */
export interface GovernedRule { field: EntityFieldDefinition; typeLabel: string; typeId: string; typeName: string; edges?: boolean }

export interface ComparisonRowProps {
  index: number
  keyName: string
  /** How the entities hold it; null for a property none of them holds yet (being added). */
  field: SharedField | null
  total: number
  change: KeyChange | null
  editable: boolean
  /** Why a value can't be given to all of them (a field no two may share), or null. */
  sharedValueRefused: string | null
  /** The entity type's field this property is, when a publish judges it (allowed values, required). */
  rule?: GovernedRule | null
  expanded: boolean
  onToggle: (key: string) => void
  onChange: (key: string, change: KeyChange | null) => void
  /** How many of them hold both `key` and `to` — what a rename onto `to` would meet. */
  conflictsFor: (key: string, to: string) => number
  /** The entities that hold no value for `key`. */
  missing: (key: string) => string[]
  memberOf: (id: string) => Member
  onFocusNode?: (id: string) => void
  onOpenNode?: (id: string) => void
  /** Just staged: the row says so for a moment. */
  staged?: boolean
}

type Form = null | 'fill' | 'rename' | 'copy'

/** A row re-renders when what it shows changes — its pending change compared by value, since the
 *  list derives a fresh one for every row on every edit. */
const sameRow = (a: ComparisonRowProps, b: ComparisonRowProps) => {
  for (const k of Object.keys(a) as Array<keyof ComparisonRowProps>) {
    if (k === 'change' ? JSON.stringify(a.change) !== JSON.stringify(b.change) : a[k] !== b[k]) return false
  }
  return Object.keys(a).length === Object.keys(b).length
}

export const ComparisonRow = memo(function ComparisonRow({
  index, keyName, field, total, change, editable, sharedValueRefused, rule = null, expanded, onToggle, onChange,
  conflictsFor, missing, memberOf, onFocusNode, onOpenNode, staged = false,
}: ComparisonRowProps) {
  const [form, setForm] = useState<Form>(null)
  const type: FieldType = field?.type ?? inferredNew(change)
  const has = field?.has ?? 0
  const removing = change?.kind === 'unset'
  const pending = change !== null
  // Of these, the ones of the field's type with no value: those its rule asks one of.
  const lacking = rule?.field.required && editable && field && has < total
    ? missing(keyName).filter((id) => memberOf(id).type === rule.typeId).length : 0
  const set = (value: unknown) => {
    if (field?.kind === 'same' && sameJson(field.value, value)) onChange(keyName, null)
    else onChange(keyName, { kind: 'set', value })
  }

  const onHeaderKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded)) { e.preventDefault(); onToggle(keyName) }
  }

  return (
    <div
      data-row-key={keyName}
      className={cn(
        'group/row rounded-xl border px-4 py-3 transition-colors',
        removing ? 'border-rose-500/30 bg-rose-500/[0.04]'
          : pending ? 'border-accent-lineage/35 bg-accent-lineage/[0.04]'
            : 'border-black/[0.07] bg-black/[0.012] dark:border-white/[0.07] dark:bg-white/[0.02] hover:border-black/[0.12] dark:hover:border-white/[0.12]',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          data-row-index={index}
          onClick={() => onToggle(keyName)}
          onKeyDown={onHeaderKey}
          aria-expanded={field ? expanded : undefined}
          disabled={!field}
          className="flex items-center gap-1.5 min-w-0 flex-1 -m-1 p-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 disabled:cursor-default"
        >
          {field ? (
            <ChevronRight aria-hidden className={cn('w-4 h-4 shrink-0 text-ink-muted transition-transform duration-150', expanded && 'rotate-90')} />
          ) : <span className="w-4 shrink-0" />}
          <span className={cn('min-w-0 truncate font-mono text-sm', removing ? 'text-ink-muted line-through' : 'text-ink')}>{keyName}</span>
        </button>
        {staged && (
          <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={MOTION.collapse}>
            <Badge tone="success" size="md"><Check className="w-3 h-3" aria-hidden /> Staged</Badge>
          </motion.span>
        )}
        <StateBadge field={field} />
        {editable && (
          <div className="flex items-center shrink-0 opacity-60 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
            {pending ? (
              <IconButton icon={RotateCcw} label={`Undo the change to ${keyName}`} size="sm" className="w-6 h-6"
                onClick={() => { onChange(keyName, null); setForm(null) }} />
            ) : field && (
              <>
                {field.kind === 'partial' && field.has > 0 && (
                  <IconButton icon={PencilLine} label={`Fill ${keyName} where missing`} detail={`On the ${(total - has).toLocaleString()} without a value`}
                    size="sm" className="w-6 h-6" disabled={!!sharedValueRefused}
                    onClick={() => setForm((f) => (f === 'fill' ? null : 'fill'))} />
                )}
                <IconButton icon={TextCursorInput} label={`Rename ${keyName}`} detail={`On the ${has.toLocaleString()} that hold it`} size="sm" className="w-6 h-6"
                  onClick={() => setForm((f) => (f === 'rename' ? null : 'rename'))} />
                <IconButton icon={CopyPlus} label={`Copy ${keyName} to a new property`} detail="Keeps the original" size="sm" className="w-6 h-6"
                  onClick={() => setForm((f) => (f === 'copy' ? null : 'copy'))} />
                <IconButton icon={Trash2} label={`Remove ${keyName} from all`} size="sm" variant="danger" className="w-6 h-6"
                  onClick={() => { onChange(keyName, { kind: 'unset' }); setForm(null) }} />
              </>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 pl-6">
        <ValueLine
          keyName={keyName}
          field={field}
          total={total}
          type={type}
          change={change}
          editable={editable && !removing && change?.kind !== 'move' && change?.kind !== 'fill'}
          refused={sharedValueRefused}
          onSet={set}
        />
        {rule && editable && !sharedValueRefused && (rule.field.allowedValues?.length ?? 0) > 0
          && !removing && change?.kind !== 'move' && change?.kind !== 'fill' && form !== 'fill' && (
          <div className="mt-1.5 flex items-start gap-1.5 min-w-0">
            <span className="shrink-0 pt-px text-2xs text-ink-muted">{rule.field.allowOther ? 'Suggested' : 'Must be one of'}</span>
            <AllowedValuePicker field={rule.field} label={keyName}
              value={change?.kind === 'set' ? change.value : field?.kind === 'same' ? field.value : undefined} onPick={set} />
          </div>
        )}
        {rule && editable && <PendingWarning rule={rule} change={change} />}
        {rule && lacking > 0 && !pending && form === null && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <FieldNote>
              {rule.field.name || keyName} is required for {rule.typeLabel} — {lacking.toLocaleString()} of these {rule.typeLabel} {lacking === 1 ? 'has' : 'have'} none.
            </FieldNote>
            <FillMissingButton typeName={rule.edges ? `${rule.typeName} relationship` : rule.typeName} onClick={() => usePropertyJobsStore.getState().requestOp(rule.edges
              ? fillRequiredConnectionsRequest({
                edgeType: rule.typeId, edgeTypeName: rule.typeName, field: keyName, fieldName: rule.field.name, scopeMode: 'view',
              })
              : fillRequiredRequest({
                entityType: rule.typeId, entityTypeName: rule.typeName, field: keyName, fieldName: rule.field.name, scopeMode: 'view',
              }))} />
          </div>
        )}
        {form === 'fill' && !pending && (
          <FillForm keyName={keyName} type={type} count={total - has} rule={rule}
            onFill={(value) => { onChange(keyName, { kind: 'fill', value }); setForm(null) }} onCancel={() => setForm(null)} />
        )}
        {(form === 'rename' || form === 'copy') && !pending && (
          <MoveForm keyName={keyName} copy={form === 'copy'} conflictsFor={(to) => conflictsFor(keyName, to)}
            onMove={(to, overwrite) => { onChange(keyName, { kind: 'move', to, keep: form === 'copy', overwrite }); setForm(null) }}
            onCancel={() => setForm(null)} />
        )}
        {field && expanded && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} transition={MOTION.collapse}>
            <ValueBreakdown
              field={field}
              missing={() => missing(keyName)}
              memberOf={memberOf}
              editable={editable && !sharedValueRefused}
              onApply={(value) => onChange(keyName, { kind: 'set', value })}
              onFill={() => setForm('fill')}
              onFocusNode={onFocusNode}
              onOpenNode={onOpenNode}
            />
          </motion.div>
        )}
      </div>
    </div>
  )
}, sameRow)

/** What publishing would refuse of the change pending — never a block: it is staged all the same. */
function PendingWarning({ rule, change }: { rule: GovernedRule; change: KeyChange | null }) {
  const removed = change?.kind === 'unset' || (change?.kind === 'move' && !change.keep)
  const warning = change?.kind === 'set' || change?.kind === 'fill'
    ? fieldWarning(rule.field, change.value, rule.typeLabel, rule.edges)
    : removed && rule.field.required ? fieldWarning(rule.field, undefined, rule.typeLabel, rule.edges) : null
  return warning ? <FieldNote className="mt-1.5">{warning}</FieldNote> : null
}

function StateBadge({ field }: { field: SharedField | null }) {
  if (!field) return <Badge tone="accent" size="md">New · for all</Badge>
  if (field.has === 0) return <Badge size="md">Not set</Badge>
  if (field.kind === 'same') return <Badge tone="success" size="md"><Check className="w-3 h-3" aria-hidden /> Same</Badge>
  if (field.kind === 'differs') return <Badge tone="warning" size="md">Differs · {field.groups.length.toLocaleString()} values</Badge>
  return (
    <HoverTip label={`${field.has.toLocaleString()} of ${field.total.toLocaleString()} hold it`}
      detail={field.groups.length > 1 ? `${field.groups.length.toLocaleString()} different values among them` : 'All of those alike'}>
      <Badge size="md">On {field.has.toLocaleString()} of {field.total.toLocaleString()}</Badge>
    </HoverTip>
  )
}

/** The value as it reads across them — or the change pending — edited where it is read. */
function ValueLine({ keyName, field, total, type, change, editable, refused, onSet }: {
  keyName: string
  field: SharedField | null
  total: number
  type: FieldType
  change: KeyChange | null
  editable: boolean
  refused: string | null
  onSet: (value: unknown) => void
}) {
  const label = `${keyName} for all`
  if (change?.kind === 'unset') {
    return <p className="text-sm text-rose-600 dark:text-rose-400">Will be removed from the {(field?.has ?? 0).toLocaleString()} that hold it.</p>
  }
  if (change?.kind === 'fill') {
    return (
      <p className="flex items-center gap-1.5 text-sm text-ink-secondary min-w-0 [&_.text-xs]:text-sm">
        <span className="shrink-0">Fill</span>
        <span className="min-w-0 truncate"><RichValue value={change.value} fieldKey={keyName} /></span>
        <span className="shrink-0 text-ink-muted">on the {(total - (field?.has ?? 0)).toLocaleString()} without one</span>
      </p>
    )
  }
  if (change?.kind === 'move') {
    return (
      <p className="flex items-center gap-1.5 text-sm text-ink-secondary min-w-0">
        {change.keep ? <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden /> : <TextCursorInput className="w-3.5 h-3.5 shrink-0" aria-hidden />}
        <span className="shrink-0">{change.keep ? 'Copy to' : 'Rename to'}</span>
        <span className="font-mono text-ink truncate">{change.to}</span>
        {change.overwrite && <span className="shrink-0 text-ink-muted">· replacing values already there</span>}
      </p>
    )
  }
  const shown = change?.kind === 'set' ? change.value : field?.kind === 'same' ? field.value : undefined
  const summary = change?.kind === 'set'
    ? <span className="inline-flex items-center gap-1.5 min-w-0"><RichValue value={change.value} fieldKey={keyName} /><span className="text-xs text-ink-muted shrink-0">for all {total.toLocaleString()}</span></span>
    : field?.kind === 'same' ? <RichValue value={field.value} fieldKey={keyName} />
      : field ? <Distribution field={field} /> : null

  if (!editable || refused) {
    return (
      <div className="min-w-0 [&_.text-xs]:text-sm">
        {summary}
        {refused && editable && <p className="mt-1 text-xs text-ink-muted">{refused}</p>}
      </div>
    )
  }
  if (type === 'boolean' && field?.kind !== 'same' && change?.kind !== 'set') {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex-1 min-w-0 [&_.text-xs]:text-sm">{summary}</div>
        <span className="text-xs text-ink-muted shrink-0">Set all</span>
        <Button size="sm" variant="subtle" onClick={() => onSet(true)}>Yes</Button>
        <Button size="sm" variant="subtle" onClick={() => onSet(false)}>No</Button>
      </div>
    )
  }
  return (
    <div className="min-w-0 [&_.text-xs]:text-sm">
      <InlineValue
        value={shown}
        fieldType={type}
        fieldLabel={label}
        onCommit={onSet}
        readView={summary ?? <span className="text-xs text-ink-muted">Not set</span>}
      />
    </div>
  )
}

/** How a property's values split across the entities: a bar of the most held, and the count. */
export function Distribution({ field }: { field: SharedField }) {
  const none = field.total - field.has
  const top = field.groups.slice(0, 3)
  const rest = field.groups.slice(3).reduce((n, g) => n + g.nodeIds.length, 0)
  const pct = (n: number) => `${(n / Math.max(1, field.total)) * 100}%`
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className="flex h-2 w-28 shrink-0 rounded-full overflow-hidden bg-black/[0.05] dark:bg-white/[0.08]" aria-hidden>
        {top.map((g, i) => <div key={g.id} className={toneOf(i)} style={{ width: pct(g.nodeIds.length) }} />)}
        {rest > 0 && <div className={OTHER_TONE} style={{ width: pct(rest) }} />}
      </div>
      <span className="text-sm text-ink-secondary truncate">
        {field.groups.length === 1
          ? <>One value · not set on {none.toLocaleString()}</>
          : <>{field.groups.length.toLocaleString()} values{none > 0 && <> · not set on {none.toLocaleString()}</>}</>}
      </span>
    </div>
  )
}

function FillForm({ keyName, type, count, rule, onFill, onCancel }: {
  keyName: string
  type: FieldType
  count: number
  rule?: GovernedRule | null
  onFill: (value: unknown) => void
  onCancel: () => void
}) {
  return (
    <div className="mt-2 rounded-lg border border-dashed border-accent-lineage/40 p-2">
      <p className="mb-1 text-2xs font-semibold text-ink-secondary">
        A value for the {count.toLocaleString()} without {keyName}
      </p>
      {type === 'boolean' ? (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="subtle" className="h-6 px-2 text-2xs" onClick={() => onFill(true)}>Yes</Button>
          <Button size="sm" variant="subtle" className="h-6 px-2 text-2xs" onClick={() => onFill(false)}>No</Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-2xs ml-auto" onClick={onCancel}>Cancel</Button>
        </div>
      ) : (
        <InlineValue value={undefined} fieldType={type} fieldLabel={`${keyName} where missing`} onCommit={onFill}
          readView={<span className="text-xs text-ink-muted">Click to type it — the others keep theirs</span>} />
      )}
      {rule && (rule.field.allowedValues?.length ?? 0) > 0 && type !== 'boolean' && (
        <AllowedValuePicker field={rule.field} label={`${keyName} where missing`} value={undefined}
          onPick={onFill} className="mt-1.5" />
      )}
    </div>
  )
}

function MoveForm({ keyName, copy, conflictsFor, onMove, onCancel }: {
  keyName: string
  copy: boolean
  conflictsFor: (to: string) => number
  onMove: (to: string, overwrite: boolean) => void
  onCancel: () => void
}) {
  const [to, setTo] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const name = to.trim()
  const error = !name ? null
    : name === keyName ? 'That is its name already'
      : RESERVED_PROPERTY_KEYS.has(name) ? `“${name}” is kept by the platform — pick another name`
        : name.length > NAME_MAX ? `Names are at most ${NAME_MAX} characters` : null
  const conflicts = name && !error ? conflictsFor(name) : 0
  const submit = () => { if (name && !error) onMove(name, overwrite) }
  return (
    <div className="mt-2 rounded-lg border border-dashed border-accent-lineage/40 p-2 space-y-1.5">
      <label className="block text-2xs font-semibold text-ink-secondary" htmlFor={`move-${keyName}`}>
        {copy ? `Copy ${keyName} to` : `Rename ${keyName} to`}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id={`move-${keyName}`}
          autoFocus
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit() }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
          }}
          placeholder="new name"
          aria-invalid={error ? true : undefined}
          className={cn('flex-1 min-w-0 px-2 py-1 rounded-md text-xs font-mono text-ink outline-none bg-canvas-elevated border',
            error ? 'border-rose-500/60' : 'border-accent-lineage/50 ring-2 ring-accent-lineage/15')}
        />
        <Button size="sm" variant="primary" className="h-6 px-2 text-2xs" disabled={!name || !!error} onClick={submit}>
          {copy ? 'Copy' : 'Rename'}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={onCancel}>Cancel</Button>
      </div>
      {error && <p role="alert" className="text-2xs text-rose-600 dark:text-rose-400">{error}</p>}
      {conflicts > 0 && (
        <label className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-300">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="mt-px accent-amber-500" />
          <span>
            {conflicts.toLocaleString()} {conflicts === 1 ? 'holds' : 'hold'} <span className="font-mono">{name}</span> already —
            {overwrite ? ' its value will be replaced.' : ' left as they are. Tick to replace it.'}
          </span>
        </label>
      )}
    </div>
  )
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function inferredNew(change: KeyChange | null): FieldType {
  if (change?.kind !== 'set' && change?.kind !== 'fill') return 'text'
  const v = change.value
  return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : Array.isArray(v) ? 'tags' : 'text'
}
