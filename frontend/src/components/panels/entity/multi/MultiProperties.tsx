/**
 * The comparison's Properties — every property any of the entities holds, one row each, saying
 * whether they hold it alike (Same), not alike (Differs), or only some do (On 7 of 12). Narrowed
 * by state or by name; J / K (or ↑ / ↓) move between rows, → opens one and ← closes it.
 *
 * In a draft the rows are edited in place, and "Add a property to all" gives every one of them a
 * new property. Long lists paint only what is on screen.
 */
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { FileText, Plus, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, IconButton } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented } from '@/components/ui/Segmented'
import type { BulkEdit, SharedField } from '@/components/canvas/context-view/bulkEdit'
import { missingNodeIds } from '@/components/canvas/context-view/bulkEdit'
import { Section } from '../../DrawerSection'
import { PropertyComposer } from '../../PropertyEditor'
import { PanelErrorBoundary } from '../../PanelErrorBoundary'
import type { PropertySuggestion } from '../../property/composerModel'
import { ComparisonRow, type GovernedRule } from './ComparisonRow'
import { changeOf, takenNames, type KeyChange } from './editOps'
import { useDrawerList } from './useDrawerList'
import type { Member } from './ValueBreakdown'

type Filter = 'all' | 'same' | 'differs' | 'partial' | 'changed'

/** A closed row and the gap below it, as drawn: 82–94px, read-only or editable. */
const ROW_ESTIMATE = 88

export function MultiProperties({
  fields, nodeIds, edit, onChange, onAddAll, editable, sharedValueRefused, fieldRuleFor, memberOf, onFocusNode, onOpenNode,
  staged, suggestions,
}: {
  fields: SharedField[]
  /** The entities compared, in order. */
  nodeIds: readonly string[]
  edit: BulkEdit
  onChange: (key: string, change: KeyChange | null) => void
  /** Several new properties, each set on all of them. */
  onAddAll: (entries: Array<[string, unknown]>) => void
  editable: boolean
  sharedValueRefused: (key: string) => string | null
  /** The entity type's field a property is, when a publish judges it. */
  fieldRuleFor?: (key: string) => GovernedRule | null
  memberOf: (id: string) => Member
  onFocusNode?: (id: string) => void
  onOpenNode?: (id: string) => void
  /** Rows just staged, marked for a moment. */
  staged: ReadonlySet<string>
  /** Names others of their type carry — offered as a property is added. */
  suggestions: () => readonly PropertySuggestion[]
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState(false)

  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields])
  // A property none of them holds yet, added for all, reads first.
  const added = useMemo(() => Object.keys(edit.set).filter((k) => !byKey.has(k)), [edit.set, byKey])
  const changed = (key: string) => changeOf(edit, key) !== null

  const counts = useMemo(() => {
    const c = { same: 0, differs: 0, partial: 0 }
    for (const f of fields) c[f.kind]++
    return c
  }, [fields])
  const changedCount = added.length + fields.filter((f) => changed(f.key)).length

  const q = query.trim().toLowerCase()
  const keys = useMemo(() => {
    const matches = (k: string) => !q || k.toLowerCase().includes(q)
    const shown = fields.filter((f) => matches(f.key) && (
      filter === 'all' || (filter === 'changed' ? changeOf(edit, f.key) !== null : f.kind === filter)))
    return [...added.filter((k) => matches(k) && (filter === 'all' || filter === 'changed')), ...shown.map((f) => f.key)]
  }, [fields, added, filter, q, edit])

  const toggle = useCallback((key: string) => setExpanded((s) => {
    const next = new Set(s)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }), [])
  const missing = useCallback((key: string) => {
    const f = byKey.get(key)
    return f ? missingNodeIds(f, nodeIds) : []
  }, [byKey, nodeIds])
  const conflictsFor = useCallback((key: string, to: string) => {
    const from = byKey.get(key)
    const target = byKey.get(to)
    if (!from || !target) return 0
    const holding = new Set(target.groups.flatMap((g) => g.nodeIds))
    let n = 0
    for (const g of from.groups) for (const id of g.nodeIds) if (holding.has(id)) n++
    return n
  }, [byKey])

  const { listRef, virtual, virtualizer } = useDrawerList(keys.length, ROW_ESTIMATE, (i) => keys[i] ?? String(i))

  // J / K and the arrows move between rows; a row far down is scrolled to first.
  const focusRow = (i: number) => {
    const find = () => listRef.current?.querySelector<HTMLElement>(`[data-row-index="${i}"]`)
    const el = find()
    if (el) { el.focus(); return }
    if (virtual) virtualizer.scrollToIndex(i, { align: 'auto' })
    requestAnimationFrame(() => find()?.focus())
  }
  const onListKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (!t.dataset.rowIndex) return
    const i = Number(t.dataset.rowIndex)
    const to = e.key === 'j' || e.key === 'ArrowDown' ? i + 1
      : e.key === 'k' || e.key === 'ArrowUp' ? i - 1
        : e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : null
    if (to === null || to < 0 || to >= keys.length) return
    e.preventDefault()
    focusRow(to)
  }

  const row = (i: number) => {
    const key = keys[i]!
    return (
      <ComparisonRow
        index={i}
        keyName={key}
        field={byKey.get(key) ?? null}
        total={nodeIds.length}
        change={changeOf(edit, key)}
        editable={editable}
        sharedValueRefused={sharedValueRefused(key)}
        rule={fieldRuleFor?.(key) ?? null}
        expanded={expanded.has(key)}
        onToggle={toggle}
        onChange={onChange}
        conflictsFor={conflictsFor}
        missing={missing}
        memberOf={memberOf}
        onFocusNode={onFocusNode}
        onOpenNode={onOpenNode}
        staged={staged.has(key)}
      />
    )
  }

  const nothing = fields.length === 0 && added.length === 0
  return (
    <Section
      title="Properties"
      icon={FileText}
      action={editable && !nothing ? (
        <Button size="sm" variant="ghost" leftIcon={Plus} onClick={() => setAdding(true)}>
          Add to all
        </Button>
      ) : undefined}
    >
      <PanelErrorBoundary resetKeys={[nodeIds.length]}>
        {nothing && !adding ? (
          <EmptyState compact icon={FileText} title="None of them has properties yet"
            description={editable ? 'Give all of them an owner, an SLA, a tag — anything worth knowing.' : undefined}
            action={editable ? { label: 'Add a property to all', onClick: () => setAdding(true) } : undefined} />
        ) : (
          <>
            {!nothing && (
              <div className="mb-4 space-y-2.5">
                <Segmented<Filter>
                  size="md"
                  label="Show properties"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: 'All', count: fields.length + added.length },
                    { value: 'same', label: 'Same', count: counts.same },
                    { value: 'differs', label: 'Differs', count: counts.differs },
                    { value: 'partial', label: 'Partial', count: counts.partial },
                    ...(changedCount > 0 ? [{ value: 'changed' as const, label: 'Changes', count: changedCount }] : []),
                  ]}
                />
                <div className="relative">
                  <Search aria-hidden className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find a property"
                    aria-label="Find a property"
                    className="w-full h-9 pl-8 pr-8 rounded-lg text-sm text-ink bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/[0.08] placeholder:text-ink-muted/70 outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                  />
                  {query && (
                    <IconButton icon={X} label="Clear" size="sm" tip={false} className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setQuery('')} />
                  )}
                </div>
              </div>
            )}

            {adding && (
              <div className="mb-3 rounded-xl border border-dashed border-accent-lineage/40 p-2">
                <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                  A property for all {nodeIds.length.toLocaleString()}
                </p>
                <PropertyComposer
                  variant="object"
                  existingKeys={[...takenNames(fields.map((f) => f.key), edit)]}
                  suggestions={suggestions()}
                  onAdd={(k, v) => { onAddAll([[k, v]]); setAdding(false) }}
                  onAddMany={(entries) => { onAddAll(entries); setAdding(false) }}
                  onUpdateExisting={(k, v) => { onAddAll([[k, v]]); setAdding(false) }}
                  onCancel={() => setAdding(false)}
                />
              </div>
            )}

            {keys.length === 0 && !nothing ? (
              <EmptyState compact icon={Search} title={q ? `No property matches “${query.trim()}”` : 'None here'}
                action={{ label: 'Show all', onClick: () => { setQuery(''); setFilter('all') } }} />
            ) : (
              <div ref={listRef} role="list" aria-label="Properties compared" onKeyDown={onListKey}
                className={cn(!virtual && 'space-y-2')}
                style={virtual ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}>
                {virtual
                  ? virtualizer.getVirtualItems().map((item) => (
                    <div key={item.key} role="listitem" data-index={item.index} ref={virtualizer.measureElement}
                      className="absolute left-0 top-0 w-full pb-2"
                      style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}>
                      {row(item.index)}
                    </div>
                  ))
                  : keys.map((key, i) => <div key={key} role="listitem">{row(i)}</div>)}
              </div>
            )}
          </>
        )}
      </PanelErrorBoundary>
    </Section>
  )
}
