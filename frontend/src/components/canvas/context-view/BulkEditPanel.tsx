/**
 * BulkEditPanel — several entities, read and edited as one.
 *
 * Opened from the selection bar for a selection of two or more. It says what
 * is held (how many, of which types) and what they SHARE: each field is either
 * the same on all of them — one value — or Mixed, with how many have it. In a
 * draft, a field set here is set on all of them, a property removed is removed
 * from all, and a property added is added to all; nothing reaches the graph
 * until Review & Save, and Undo on the toast puts everything back. Outside a
 * draft it is the same comparison, read-only, with the way into one.
 *
 * The selection is the one the panel was opened with: clicking around the
 * canvas while it is open never changes what an edit would touch.
 */
import { AlertCircle, Check, Layers, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button, IconButton } from '@/components/ui/Button'
import { useAppNotifications } from '@/components/ui/notifications'
import { cn } from '@/lib/utils'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'

import { DrawerBody, DrawerFooter, DrawerFrame, DrawerHeader } from '../../panels/shell/DrawerShell'
import { isEmptyBulkEdit, sharedFields, stageBulkEdit, type BulkEdit, type SharedField } from './bulkEdit'

type Data = Record<string, unknown>

const isScalar = (v: unknown) => v === undefined || v === null || ['string', 'number', 'boolean'].includes(typeof v)
const asText = (v: unknown) => (v === undefined || v === null ? '' : String(v))

/** Text typed for a field, kept as the kind of value the field holds. */
function coerceLike(sample: unknown, text: string): unknown {
  const t = text.trim()
  if (typeof sample === 'number' && t !== '' && Number.isFinite(Number(t))) return Number(t)
  if (typeof sample === 'boolean' && /^(true|false)$/i.test(t)) return t.toLowerCase() === 'true'
  return text
}

const LABEL = 'block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted'
const INPUT = 'w-full rounded-lg border border-black/[0.10] dark:border-white/[0.10] bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

export function BulkEditPanel({ nodeIds, canEdit, onStartEditing, onClose }: {
  /** The entities, as selected when the panel opened. */
  nodeIds: readonly string[]
  /** In a draft the canvas can write to: the panel edits; otherwise it compares. */
  canEdit: boolean
  /** Outside a draft: open one. */
  onStartEditing?: () => void
  onClose: () => void
}) {
  const allNodes = useCanvasStore((s) => s.nodes)
  const entityTypes = useSchemaStore((s) => s.schema?.entityTypes)
  const { notify } = useAppNotifications()

  const held = useMemo(() => {
    const byId = new Map(allNodes.map((n) => [n.id, n]))
    return nodeIds.map((id) => byId.get(id)).filter((n): n is LineageNode => !!n)
  }, [allNodes, nodeIds])
  const fields = useMemo(() => sharedFields(held as ReadonlyArray<{ data: Data }>), [held])

  // How many of each type — the selection in the reader's words.
  const breakdown = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of held) {
      const t = String((n.data as Data).type ?? '')
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].map(([id, count]) => {
      const type = entityTypes?.find((e) => e.id === id)
      return {
        id, count,
        label: count === 1 ? (type?.name ?? id) : (type?.pluralName ?? `${type?.name ?? id}s`),
        color: type?.visual?.color ?? '#6366f1',
      }
    }).sort((a, b) => b.count - a.count)
  }, [held, entityTypes])

  // ── The edit ──
  const [description, setDescription] = useState<string | undefined>(undefined)
  const [set, setSet] = useState<Record<string, string>>({})
  const [unset, setUnset] = useState<ReadonlySet<string>>(new Set())
  const [added, setAdded] = useState<string[]>([])
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  // A value each property holds — what typed text is kept as (a number stays a number).
  const samples = useMemo(() => new Map(fields.properties.map((f) => [
    f.key,
    f.state === 'same' ? f.value : held.map((n) => ((n.data as Data).properties as Data | undefined)?.[f.key]).find((v) => v !== undefined),
  ])), [fields, held])
  const edit: BulkEdit = useMemo(() => ({
    description,
    set: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, samples.has(k) ? coerceLike(samples.get(k), v) : v])),
    unset: [...unset],
  }), [description, set, unset, samples])
  const changeCount = (description !== undefined ? 1 : 0) + Object.keys(set).length + unset.size

  const stage = () => {
    if (!canEdit || isEmptyBulkEdit(edit)) return
    const undo = stageBulkEdit(held, edit)
    notify(
      'success',
      `Staged ${changeCount} ${changeCount === 1 ? 'change' : 'changes'} on ${held.length} entities — Review & Save keeps them.`,
      { label: 'Undo', onClick: undo },
    )
    onClose()
  }

  const keys = [...fields.properties.map((f) => f.key), ...added.filter((k) => !fields.properties.some((f) => f.key === k))]
  const addProperty = () => {
    const key = newKey.trim()
    if (!key) return
    setSet((s) => ({ ...s, [key]: newValue }))
    setUnset((u) => { const next = new Set(u); next.delete(key); return next })
    if (!keys.includes(key)) setAdded((a) => [...a, key])
    setNewKey('')
    setNewValue('')
  }

  return (
    <DrawerFrame panel="bulk-edit" label="Several entities">
      <DrawerHeader className="bg-gradient-to-br from-accent-lineage/[0.08] to-transparent">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-lineage/15 text-accent-lineage shadow-sm shadow-accent-lineage/10">
            <Layers className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight text-ink">{held.length} entities</h2>
            <p className="mt-0.5 text-[12px] text-ink-muted">
              {canEdit ? 'What they share — change it for all of them at once.' : 'What they share, side by side.'}
            </p>
          </div>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {breakdown.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-canvas px-2 py-1 text-[11.5px] text-ink">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} aria-hidden />
              <span className="tabular-nums font-semibold">{t.count}</span> {t.label}
            </span>
          ))}
        </div>
      </DrawerHeader>

      <DrawerBody>
        <div className="space-y-5 p-5">
          {!canEdit && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <div className="min-w-0 flex-1 text-[12px] leading-snug text-ink">
                Changes to entities are kept in a draft, and published from there.
                {onStartEditing && (
                  <div className="mt-2">
                    <Button size="sm" variant="secondary" onClick={onStartEditing}>Edit in a draft</Button>
                  </div>
                )}
              </div>
            </div>
          )}

          <section aria-label="Description">
            <div className="mb-1.5 flex items-center gap-2">
              <span className={LABEL}>Description</span>
              <SameOrMixed field={fields.description} />
            </div>
            {canEdit ? (
              <textarea
                aria-label="Description for all"
                rows={3}
                value={description ?? (fields.description.state === 'same' ? asText(fields.description.value) : '')}
                placeholder={fields.description.state === 'mixed' ? 'Mixed — type to give all of them this description' : 'Add a description for all of them'}
                onChange={(e) => setDescription(e.target.value)}
                className={cn(INPUT, 'resize-y leading-relaxed')}
              />
            ) : (
              <p className="text-[13px] leading-relaxed text-ink">
                {fields.description.state === 'same' && asText(fields.description.value)
                  ? asText(fields.description.value)
                  : <span className="italic text-ink-muted">{fields.description.state === 'mixed' ? 'They differ.' : 'None.'}</span>}
              </p>
            )}
            {description !== undefined && (
              <button type="button" onClick={() => setDescription(undefined)}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink">
                <RotateCcw className="h-3 w-3" aria-hidden /> Leave each as it is
              </button>
            )}
          </section>

          <section aria-label="Properties">
            <span className={cn(LABEL, 'mb-1.5')}>Properties</span>
            {keys.length === 0 && <p className="text-[12px] italic text-ink-muted">None of them has properties yet.</p>}
            <ul className="space-y-1.5">
              {keys.map((key) => {
                const field = fields.properties.find((f) => f.key === key)
                const removing = unset.has(key)
                const value = set[key]
                const editable = canEdit && (!field || isScalar(samples.get(key)))
                return (
                  <li key={key}
                      className={cn('rounded-xl border px-3 py-2.5 transition-colors',
                        removing ? 'border-rose-500/30 bg-rose-500/[0.05]' : value !== undefined ? 'border-accent-lineage/35 bg-accent-lineage/[0.05]' : 'border-black/[0.08] bg-black/[0.015] dark:border-white/[0.08] dark:bg-white/[0.02]')}>
                    <div className="flex items-center gap-2">
                      <span className={cn('min-w-0 flex-1 truncate font-mono text-[12px]', removing ? 'text-ink-muted line-through' : 'text-ink')}>{key}</span>
                      {field ? <SameOrMixed field={field} /> : <span className="text-[10px] font-medium text-accent-lineage">New</span>}
                      {canEdit && (removing ? (
                        <IconButton icon={RotateCcw} label={`Keep ${key}`} size="sm"
                                    onClick={() => setUnset((u) => { const next = new Set(u); next.delete(key); return next })} />
                      ) : (
                        <IconButton icon={Trash2} label={`Remove ${key} from all`} size="sm" variant="danger"
                                    onClick={() => {
                                      setUnset((u) => new Set(u).add(key))
                                      setSet((s) => { const next = { ...s }; delete next[key]; return next })
                                    }} />
                      ))}
                    </div>
                    {!removing && (editable ? (
                      <input
                        aria-label={`${key} for all`}
                        value={value ?? (field?.state === 'same' ? asText(field.value) : '')}
                        placeholder={field?.state === 'mixed' ? `Mixed · on ${field.has} of ${field.total} — type to set for all` : ''}
                        onChange={(e) => setSet((s) => ({ ...s, [key]: e.target.value }))}
                        className={cn(INPUT, 'mt-1.5')}
                      />
                    ) : (
                      <p className="mt-1 text-[12.5px] text-ink">
                        {field?.state === 'same' ? (isScalar(field.value) ? asText(field.value) : JSON.stringify(field.value))
                          : <span className="italic text-ink-muted">Mixed · on {field?.has} of {field?.total}</span>}
                      </p>
                    ))}
                    {removing && <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">Will be removed from all {held.length}.</p>}
                  </li>
                )
              })}
            </ul>

            {canEdit && (
              <div className="mt-3 rounded-xl border border-dashed border-black/[0.14] p-3 dark:border-white/[0.14]">
                <span className={cn(LABEL, 'mb-1.5')}>Add a property to all</span>
                <div className="flex items-center gap-2">
                  <input aria-label="New property name" value={newKey} placeholder="Name" onChange={(e) => setNewKey(e.target.value)}
                         className={cn(INPUT, 'w-[40%] font-mono')} />
                  <input aria-label="New property value" value={newValue} placeholder="Value" onChange={(e) => setNewValue(e.target.value)}
                         onKeyDown={(e) => { if (e.key === 'Enter') addProperty() }} className={INPUT} />
                  <IconButton icon={Plus} label="Add to all" size="sm" variant="subtle" disabled={!newKey.trim()} onClick={addProperty} />
                </div>
              </div>
            )}
          </section>
        </div>
      </DrawerBody>

      {canEdit && (
        <DrawerFooter className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11.5px] text-ink-muted">
            {changeCount === 0 ? 'Nothing changed yet.' : `${changeCount} ${changeCount === 1 ? 'change' : 'changes'} · for ${held.length} entities`}
          </span>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={changeCount === 0} onClick={stage}>
            Stage for {held.length}
          </Button>
        </DrawerFooter>
      )}
    </DrawerFrame>
  )
}

function SameOrMixed({ field }: { field: SharedField }) {
  if (field.has === 0) return <span className="text-[10px] text-ink-muted">None set</span>
  return field.state === 'same' ? (
    <span className="inline-flex items-center gap-0.5 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
      <Check className="h-2.5 w-2.5" aria-hidden /> Same
    </span>
  ) : (
    <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
      Mixed · {field.has} of {field.total}
    </span>
  )
}
