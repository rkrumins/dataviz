/**
 * The What step of a clean-up — the values a property holds, tidied on every entity that holds
 * them — each with a live before → after on the values the view holds:
 *
 * - **Find & replace**: what to find and what to put instead, in any case unless asked, or only a
 *   whole value;
 * - **Normalize**: trim, one space for many, one case, in lists each value once — and which values
 *   it makes one;
 * - **Merge values**: the near-duplicates the property holds ("Finance", "finance ", "FINANCE"),
 *   from every value the view keeps for it — each group on or off, with the value to keep;
 * - **Convert kind**: how the values are stored now, the kind to store them as, and which won't
 *   convert (left as they are, or removed).
 *
 * The preview reads the values the catalog lists, the server's rule written again (`cleanup.ts`);
 * the server's reading of every entity is the one applied. A clean-up of relationships, whose values
 * no catalog counts, previews those read from the relationships it reaches (`relationships`).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Info, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import { DrawerScrollContext } from '@/components/panels/shell/drawerScroll'
import { useDrawerList } from '@/components/panels/entity/multi/useDrawerList'
import type { ValueKind } from '@/services/versioningApiService'
import type { SearchCatalogProperty, SearchCatalogValue } from '@/types/search'
import { cleanValue, mergeMap, similarGroups, type SimilarGroup } from './cleanup'
import { VALUE_KIND_LABEL, type OpDraft } from './opModel'
import { FIELD, LABEL } from './styles'
import { useAllValues, type AllValues } from './useAllValues'
import type { RelationshipValues } from './useRelationshipValues'

/** Rows a preview shows of each list. */
const SHOWN = 6
/** A merge group's height before it is measured: a few values, one per line. */
const GROUP_ESTIMATE = 96

export function CleanupFields({ op, onChange, known, viewId, relationships }: {
  op: OpDraft
  onChange: (patch: Partial<OpDraft>) => void
  /** The property as the catalog reads it in this view, if any entity holds it — for relationships,
   *  as those read hold it. */
  known: SearchCatalogProperty | null
  viewId: string
  /** A clean-up of relationships: the values read from those it reaches, which `known` holds. */
  relationships?: RelationshipValues
}) {
  if (relationships?.loading && !known) {
    return <div className="space-y-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full rounded-lg" />)}</div>
  }
  const who = holders(relationships)
  const fields = (() => {
    switch (op.kind) {
      case 'replace': return <ReplaceFields op={op} onChange={onChange} known={known} who={who} />
      case 'normalize': return <NormalizeFields op={op} onChange={onChange} known={known} who={who} />
      case 'mapValues': return <MergeFields op={op} onChange={onChange} known={known} viewId={viewId} who={who} />
      case 'convert': return <ConvertFields op={op} onChange={onChange} known={known} viewId={viewId} who={who} />
      default: return null
    }
  })()
  if (!relationships?.error) return fields
  return <div className="space-y-3"><ReadFailed all={relationships} listed={known?.values?.length ?? 0} />{fields}</div>
}

/** Whose values a preview reads, in words. */
interface Holders {
  /** Those holding a value, after a count: "entities in this view". */
  some: string
  /** The values they hold. */
  values: string
  /** None of them holds one: why there is nothing to preview. */
  none: string
  /** Who the change still reaches when there are too many values to preview. */
  every: string
  /** Its values are the view's catalog's, where values are picked to merge. */
  catalog: boolean
}

/** The view's entities — the catalog's values — or the relationships read for a clean-up of them. */
function holders(relationships?: RelationshipValues): Holders {
  if (!relationships) {
    return { some: 'entities in this view', values: 'the values this view holds', every: 'every entity holding one', catalog: true,
      none: 'This view’s entities hold none of its values yet, so there is nothing to preview.' }
  }
  const read = relationships.truncated ? `the first ${relationships.read.toLocaleString()} relationships it reaches` : 'the relationships it reaches'
  return { some: relationships.truncated ? `of ${read}` : 'relationships it reaches', values: `the values ${read} hold`,
    every: 'every relationship holding one', catalog: false, none: `None of ${read} holds a value of it, so there is nothing to preview.` }
}

// ── Find & replace ─────────────────────────────────────────────────────────────
function ReplaceFields({ op, onChange, known, who }: {
  op: OpDraft; onChange: (p: Partial<OpDraft>) => void; known: SearchCatalogProperty | null; who: Holders
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="op-find">Find</label>
          <input id="op-find" value={op.find ?? ''} onChange={(e) => onChange({ find: e.target.value })} placeholder="e.g. Fin."
            maxLength={256} className={cn(FIELD, 'font-mono')} />
        </div>
        <div>
          <label className={LABEL} htmlFor="op-replace">Replace with</label>
          <input id="op-replace" value={op.replaceWith ?? ''} onChange={(e) => onChange({ replaceWith: e.target.value })}
            placeholder="nothing — remove it" maxLength={256} className={cn(FIELD, 'font-mono')} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Toggle label="Match case" checked={!!op.matchCase} onChange={(matchCase) => onChange({ matchCase })} />
        <Toggle label="Whole value only" checked={!!op.wholeValue} onChange={(wholeValue) => onChange({ wholeValue })}
          detail="Replace a value only when it is all of it" />
      </div>
      {op.find ? <Preview op={op} values={known?.values ?? []} distinct={known?.distinct} unlisted={unlisted(known)} who={who} />
        : <Hint>Type what to find to see what it changes in {who.values}.</Hint>}
      <Hint>Only text is changed — in a list, each text value. A value that ends up reading as a date is stored the way dates are (YYYY-MM-DD).</Hint>
    </div>
  )
}

// ── Normalize ──────────────────────────────────────────────────────────────────
type CaseChoice = 'keep' | 'lower' | 'upper' | 'title'

function NormalizeFields({ op, onChange, known, who }: {
  op: OpDraft; onChange: (p: Partial<OpDraft>) => void; known: SearchCatalogProperty | null; who: Holders
}) {
  const values = useMemo(() => known?.values ?? [], [known])
  // Distinct values that become one: what tidying the text merges.
  const merged = useMemo(() => {
    const into = new Map<string, SearchCatalogValue[]>()
    for (const v of values) {
      const after = cleanValue(op, v.value, v.kind)
      const k = JSON.stringify([after.kind, after.value])
      into.set(k, [...(into.get(k) ?? []), v])
    }
    return [...into.values()].filter((vs) => vs.length > 1)
  }, [op, values])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Toggle label="Trim spaces at either end" checked={op.trim ?? true} onChange={(trim) => onChange({ trim })} />
        <Toggle label="One space for many" checked={!!op.collapseSpaces} onChange={(collapseSpaces) => onChange({ collapseSpaces })} />
        <Toggle label="In lists, each value once" checked={!!op.dedupeList} onChange={(dedupeList) => onChange({ dedupeList })} />
      </div>
      <div>
        <span className={LABEL}>Case</span>
        <Segmented<CaseChoice>
          label="Case"
          size="md"
          value={op.case ?? 'keep'}
          onChange={(c) => onChange({ case: c === 'keep' ? null : c })}
          options={[
            { value: 'keep', label: 'As it is' }, { value: 'lower', label: 'lower' },
            { value: 'upper', label: 'UPPER' }, { value: 'title', label: 'Title' },
          ]}
        />
      </div>
      <Preview op={op} values={values} distinct={known?.distinct} unlisted={unlisted(known)} who={who} />
      {merged.length > 0 && (
        <Hint tone="warning">
          {merged.length === 1 ? 'Two or more values become one' : `${merged.length} sets of values become one each`}:{' '}
          {merged.slice(0, 3).map((vs, i) => (
            <span key={i}>{i > 0 && '; '}{vs.map((v) => quote(v.value)).join(', ')}</span>
          ))}
          {merged.length > 3 && '…'}
        </Hint>
      )}
    </div>
  )
}

// ── Merge values ───────────────────────────────────────────────────────────────
function MergeFields({ op, onChange, known, viewId, who }: {
  op: OpDraft; onChange: (p: Partial<OpDraft>) => void; known: SearchCatalogProperty | null; viewId: string; who: Holders
}) {
  // A relationship's values are only those read for it (`known`): no catalog lists more.
  const all = useAllValues(viewId, op.key.trim(), who.catalog)
  const values = useMemo(() => all.values ?? known?.values ?? [], [all.values, known?.values])
  // How many entities hold each value, by value: what the counts here look up.
  const held = useMemo(() => new Map(values.map((v) => [key(v), v.count])), [values])
  // A merge asked for from the catalog (its value bars' "Merge into…") is the first group, kept.
  const [asked] = useState(() => askedGroup(op.map ?? [], held))
  const groups = useMemo(() => {
    const suggested = similarGroups(values)
    if (!asked) return suggested
    const taken = new Set(asked.members.map((m) => key(m)))
    return [asked, ...suggested.filter((g) => !g.members.some((m) => taken.has(key(m))))]
  }, [values, asked])
  // Each group: the member kept (an index into it), or null when it is left out. Asked for: only
  // that group, to begin with; otherwise every suggestion.
  const [choice, setChoice] = useState<Record<string, number | null>>({})
  const pickedIn = (c: Record<string, number | null>, g: SimilarGroup) => (g.key in c ? c[g.key]! : asked && g !== asked ? null : g.canonical)
  const mapOf = (c: Record<string, number | null>) => mergeMap(groups.flatMap((g) => {
    const kept = pickedIn(c, g)
    return kept === null ? [] : [{ members: g.members, canonical: kept }]
  }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const map = useMemo(() => mapOf(choice), [groups, choice])
  // A choice is sent as it is made — one change per click.
  const choose = (g: SimilarGroup, kept: number | null) => {
    const next = { ...choice, [g.key]: kept }
    setChoice(next)
    onChange({ map: mapOf(next) })
  }
  // The groups themselves change as every value it holds arrives: the merge they make then is sent.
  useEffect(() => {
    if (JSON.stringify(map) !== JSON.stringify(op.map ?? [])) onChange({ map })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups])

  const tooMany = known && !known.distinctExact && known.values.length === 0
  if (tooMany) {
    return <Hint>It holds more than {known.distinct.toLocaleString()} distinct values — too many to list and merge here. Use Find &amp; replace with “Whole value only” instead.</Hint>
  }
  if (all.loading && values.length === 0) return <div className="space-y-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full rounded-lg" />)}</div>
  const entities = map.reduce((n, m) => n + (held.get(key({ value: m.from, kind: m.fromKind ?? '' })) ?? 0), 0)
  return (
    <div className="space-y-3">
      <ReadFailed all={all} listed={values.length} />
      {groups.length === 0 ? (
        <Hint>
          None of its {values.length.toLocaleString()} values differ only in case or in spaces around them.
          {who.catalog && <> To merge other values, select them in the property’s values on the Properties tab and choose{' '}
            <span className="font-semibold">Merge into…</span></>}
        </Hint>
      ) : (
        <>
          <p className="text-[13px] text-ink-muted">
            {asked ? 'The values you chose, and others' : 'Values'} that read as one once case and spaces are set aside — pick the one to keep.
            {all.loading && ' Reading every value it holds…'}
          </p>
          <GroupList groups={groups} group={(g) => {
              const c = pickedIn(choice, g)
              const total = g.members.reduce((n, m) => n + m.count, 0)
              return (
                <div className={cn('rounded-lg border p-2', c !== null ? 'border-accent-lineage/30 bg-accent-lineage/[0.04]' : 'border-black/[0.07] dark:border-white/[0.08]')}>
                  <label className="flex items-center gap-2 text-[13px] text-ink">
                    <input type="checkbox" className="accent-indigo-500" checked={c !== null}
                      onChange={(e) => choose(g, e.target.checked ? g.canonical : null)} />
                    <span className="flex-1 min-w-0 truncate">
                      {g.members.length} values → <span className="font-mono">{quote(g.members[c ?? g.canonical]!.value)}</span>
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">{total.toLocaleString()}</span>
                  </label>
                  <div role="radiogroup" aria-label={`Keep which of ${g.members.length} values`} className="mt-1 pl-6 space-y-0.5">
                    {g.members.map((m, i) => (
                      <label key={key(m)} className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
                        <input type="radio" name={`keep-${g.key}`} className="accent-indigo-500" checked={(c ?? g.canonical) === i}
                          onChange={() => choose(g, i)} aria-label={`Keep ${quote(m.value)}`} />
                        <span className="flex-1 min-w-0 truncate font-mono whitespace-pre">{quote(m.value)}</span>
                        <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">{m.count.toLocaleString()}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            }} />
          <p className="text-[13px] text-ink-secondary" aria-live="polite">
            {map.length === 0 ? 'Nothing chosen to merge.'
              : <>Merges <span className="font-semibold tabular-nums">{map.length.toLocaleString()}</span> value{map.length === 1 ? '' : 's'} into another — held by about <span className="tabular-nums">{entities.toLocaleString()}</span> {who.some}.</>}
          </p>
        </>
      )}
      <Toggle label="In lists, each value once" checked={op.dedupeList ?? true} onChange={(dedupeList) => onChange({ dedupeList })}
        detail="A list holding two of the merged values keeps one" />
    </div>
  )
}

const key = (v: { value: unknown; kind: string }) => JSON.stringify([v.kind, v.value])

/** The merge's groups, in a list of its own height: past a hundred, only those in view are drawn. */
function GroupList({ groups, group }: { groups: readonly SimilarGroup[]; group: (g: SimilarGroup) => ReactNode }) {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  return (
    <div ref={setScrollEl} className="max-h-72 overflow-y-auto custom-scrollbar pr-0.5">
      <DrawerScrollContext.Provider value={scrollEl}>
        <GroupRows groups={groups} group={group} />
      </DrawerScrollContext.Provider>
    </div>
  )
}

function GroupRows({ groups, group }: { groups: readonly SimilarGroup[]; group: (g: SimilarGroup) => ReactNode }) {
  const { listRef, virtual, virtualizer } = useDrawerList(groups.length, GROUP_ESTIMATE, (i) => groups[i]?.key ?? String(i))
  return (
    <div ref={listRef} role="list" aria-label="Values to merge" className={cn(!virtual && 'space-y-1.5')}
      style={virtual ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}>
      {virtual
        ? virtualizer.getVirtualItems().map((item) => (
          <div key={item.key} role="listitem" data-index={item.index} ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full pb-1.5"
            style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}>
            {group(groups[item.index]!)}
          </div>
        ))
        : groups.map((g) => <div key={g.key} role="listitem">{group(g)}</div>)}
    </div>
  )
}

/** The group a merge asked for from the catalog names: what it merges, and what into. */
function askedGroup(map: NonNullable<OpDraft['map']>, held: ReadonlyMap<string, number>): SimilarGroup | null {
  if (map.length === 0) return null
  const count = (value: unknown, kind: string) => held.get(key({ value, kind })) ?? 0
  const into = { value: map[0]!.to, kind: map[0]!.toKind ?? 'String' }
  const members: SearchCatalogValue[] = [{ ...into, count: count(into.value, into.kind) }]
  for (const m of map) {
    const from = { value: m.from, kind: m.fromKind ?? 'String' }
    if (!members.some((x) => key(x) === key(from))) members.push({ ...from, count: count(from.value, from.kind) })
  }
  return { key: `asked:${key(into)}`, members, canonical: 0 }
}

// ── Convert kind ───────────────────────────────────────────────────────────────
const KINDS: ValueKind[] = ['Integer', 'Float', 'String', 'Boolean']

function ConvertFields({ op, onChange, known, viewId, who }: {
  op: OpDraft; onChange: (p: Partial<OpDraft>) => void; known: SearchCatalogProperty | null; viewId: string; who: Holders
}) {
  const all = useAllValues(viewId, op.key.trim(), who.catalog)
  const values = useMemo(() => all.values ?? known?.values ?? [], [all.values, known?.values])
  const kinds = Object.entries(known?.kinds ?? {}).sort((a, b) => b[1] - a[1])
  const fails = useMemo(
    () => (op.toKind ? values.filter((v) => cleanValue({ ...op, onFail: 'skip' }, v.value, v.kind).fails) : []),
    [values, op])
  const converts = useMemo(() => {
    const failing = new Set(fails)
    return values.filter((v) => !failing.has(v))
  }, [values, fails])
  return (
    <div className="space-y-3">
      <ReadFailed all={all} listed={values.length} />
      {kinds.length > 0 && (
        <p className="text-[13px] text-ink-secondary">
          Stored as {kinds.map(([kind, n], i) => (
            <span key={kind}>
              {i > 0 && (i === kinds.length - 1 ? ' and ' : ', ')}
              <span className="font-semibold">{VALUE_KIND_LABEL[kind as ValueKind] ?? kind}</span> on <span className="tabular-nums">{n.toLocaleString()}</span>
            </span>
          ))} {who.some}.
        </p>
      )}
      <div>
        <span className={LABEL}>Store every value as</span>
        <Segmented<ValueKind>
          label="Store every value as"
          size="md"
          value={op.toKind ?? ('' as ValueKind)}
          onChange={(toKind) => onChange({ toKind })}
          options={KINDS.map((k) => ({ value: k, label: VALUE_KIND_LABEL[k], count: known?.kinds?.[k] }))}
        />
      </div>
      {op.toKind && (
        <>
          <Preview op={{ ...op, onFail: 'skip' }} values={converts} distinct={known?.distinct} unlisted={unlisted(known)} who={who} title="Converts" />
          {fails.length > 0 ? (
            <fieldset className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
              <legend className="px-1 text-xs text-amber-700 dark:text-amber-300">
                {fails.length.toLocaleString()} value{fails.length === 1 ? '' : 's'} won’t convert to {VALUE_KIND_LABEL[op.toKind]} — held by{' '}
                {fails.reduce((n, v) => n + v.count, 0).toLocaleString()} {who.some}:
              </legend>
              <ul className="mb-1.5 flex flex-wrap gap-1" aria-label="Values that won’t convert">
                {fails.slice(0, 12).map((v) => (
                  <li key={key(v)} className="inline-flex items-center gap-1 rounded-md bg-black/[0.04] px-1.5 py-0.5 font-mono text-xs text-ink-secondary dark:bg-white/[0.06]">
                    <span className="whitespace-pre">{quote(v.value)}</span>
                    <span className="tabular-nums text-ink-muted">{v.count.toLocaleString()}</span>
                  </li>
                ))}
                {fails.length > 12 && <li className="self-center text-xs text-ink-muted">and {(fails.length - 12).toLocaleString()} more</li>}
              </ul>
              {(['skip', 'remove'] as const).map((choice) => (
                <label key={choice} className="flex items-center gap-2 py-0.5 text-[13px] text-ink">
                  <input type="radio" name="op-on-fail" checked={(op.onFail ?? 'skip') === choice} onChange={() => onChange({ onFail: choice })}
                    className="accent-indigo-500" />
                  {choice === 'skip' ? 'Leave them as they are (listed when it ends)' : `Remove ${op.key.trim()} from them`}
                </label>
              ))}
            </fieldset>
          ) : values.length > 0 && (
            <Hint>Every value listed here converts.</Hint>
          )}
          <Hint>A number keeps every digit: text that isn’t exactly a number (“1e3”, “n/a”), a decimal that isn’t whole as an integer, or yes/no as a number, won’t convert.</Hint>
        </>
      )}
    </div>
  )
}

// ── Shared ─────────────────────────────────────────────────────────────────────
/** The catalog counts the property's values but lists none: it holds too many to list. */
const unlisted = (known: SearchCatalogProperty | null) => !!known && !known.distinctExact && known.values.length === 0

/** Every value it holds couldn't be read: said, with the values shown instead, and a retry. */
function ReadFailed({ all, listed }: { all: AllValues; listed: number }) {
  if (!all.error) return null
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.06] p-3 text-[13px] leading-snug text-amber-800 dark:text-amber-200">
      <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        Couldn’t read every value it holds: {all.error}.{' '}
        {listed === 0 ? 'None are shown.' : listed === 1 ? 'Only the one most held is shown.' : `Only the ${listed.toLocaleString()} most held are shown.`}
      </span>
      <Button size="sm" variant="ghost" leftIcon={RotateCw} className="-my-1 h-7 shrink-0 px-2 text-xs" onClick={all.retry}>Retry</Button>
    </div>
  )
}

/** Before → after for the values listed that the clean-up changes, the most held first. */
function Preview({ op, values, distinct, unlisted: tooMany = false, who, title = 'Changes' }: {
  op: OpDraft; values: readonly SearchCatalogValue[]; distinct?: number
  /** It holds more values than the catalog lists. */
  unlisted?: boolean
  who: Holders
  title?: string
}) {
  const changed = values.map((v) => ({ v, out: cleanValue(op, v.value, v.kind) })).filter((r) => r.out.changed)
  if (values.length === 0) {
    return tooMany
      ? <Hint>It holds more than {(distinct ?? 0).toLocaleString()} values — too many to preview here. The change still reaches {who.every}.</Hint>
      : <Hint>{who.none}</Hint>
  }
  const entities = changed.reduce((n, r) => n + r.v.count, 0)
  const of = distinct !== undefined && distinct > values.length ? ` of the ${values.length.toLocaleString()} most held` : ''
  return (
    <div>
      <span className={LABEL}>{title}</span>
      {changed.length === 0 ? (
        <p className="text-[13px] text-ink-muted">None of the values{of} would change.</p>
      ) : (
        <>
          <ul className="space-y-1" aria-label="Before and after">
            {changed.slice(0, SHOWN).map(({ v, out }) => (
              <li key={key(v)} className="flex items-center gap-1.5 text-[12.5px]">
                <span className="min-w-0 truncate rounded bg-rose-500/[0.06] px-1.5 py-0.5 font-mono whitespace-pre text-ink-secondary">{quote(v.value)}</span>
                <ArrowRight className="h-3 w-3 shrink-0 text-ink-muted" aria-hidden />
                <span className="min-w-0 truncate rounded bg-emerald-500/[0.08] px-1.5 py-0.5 font-mono whitespace-pre text-ink">
                  {out.value === undefined ? <span className="italic font-sans">removed</span> : quote(out.value)}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-muted">{v.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-ink-muted">
            {changed.length.toLocaleString()} value{changed.length === 1 ? '' : 's'}{of} change — on{' '}
            <span className="tabular-nums">{entities.toLocaleString()}</span> {who.some}
            {changed.length > SHOWN && `; the first ${SHOWN} shown`}.
          </p>
        </>
      )}
    </div>
  )
}

/** A value as it is written, quoted so spaces around it show. */
function quote(value: unknown): string {
  return typeof value === 'string' ? `“${value}”` : JSON.stringify(value)
}

function Toggle({ label, checked, onChange, detail }: { label: string; checked: boolean; onChange: (on: boolean) => void; detail?: string }) {
  return (
    <label className="inline-flex items-center gap-2 py-0.5 text-[13px] text-ink">
      <input type="checkbox" className="accent-indigo-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{detail && <span className="text-ink-muted"> — {detail}</span>}</span>
    </label>
  )
}

function Hint({ children, tone }: { children: ReactNode; tone?: 'warning' }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-xs leading-snug', tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-ink-muted')}>
      <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}
