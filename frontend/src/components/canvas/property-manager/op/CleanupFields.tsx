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
 * the server's reading of every entity is the one applied.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import type { ValueKind } from '@/services/versioningApiService'
import type { SearchCatalogProperty, SearchCatalogValue } from '@/types/search'
import { cleanValue, mergeMap, similarGroups, type SimilarGroup } from './cleanup'
import { VALUE_KIND_LABEL, type OpDraft } from './opModel'
import { FIELD, LABEL } from './styles'
import { useAllValues } from './useAllValues'

/** Rows a preview shows of each list. */
const SHOWN = 6

export function CleanupFields({ op, onChange, known, viewId }: {
  op: OpDraft
  onChange: (patch: Partial<OpDraft>) => void
  /** The property as the catalog reads it in this view, if any entity holds it. */
  known: SearchCatalogProperty | null
  viewId: string
}) {
  switch (op.kind) {
    case 'replace': return <ReplaceFields op={op} onChange={onChange} known={known} />
    case 'normalize': return <NormalizeFields op={op} onChange={onChange} known={known} />
    case 'mapValues': return <MergeFields op={op} onChange={onChange} known={known} viewId={viewId} />
    case 'convert': return <ConvertFields op={op} onChange={onChange} known={known} viewId={viewId} />
    default: return null
  }
}

// ── Find & replace ─────────────────────────────────────────────────────────────
function ReplaceFields({ op, onChange, known }: { op: OpDraft; onChange: (p: Partial<OpDraft>) => void; known: SearchCatalogProperty | null }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
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
      {op.find ? <Preview op={op} values={known?.values ?? []} distinct={known?.distinct} />
        : <Hint>Type what to find to see what it changes in the values this view holds.</Hint>}
      <Hint>Only text is changed — in a list, each text value. A value that ends up reading as a date is stored the way dates are (YYYY-MM-DD).</Hint>
    </div>
  )
}

// ── Normalize ──────────────────────────────────────────────────────────────────
type CaseChoice = 'keep' | 'lower' | 'upper' | 'title'

function NormalizeFields({ op, onChange, known }: { op: OpDraft; onChange: (p: Partial<OpDraft>) => void; known: SearchCatalogProperty | null }) {
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
          value={op.case ?? 'keep'}
          onChange={(c) => onChange({ case: c === 'keep' ? null : c })}
          options={[
            { value: 'keep', label: 'As it is' }, { value: 'lower', label: 'lower' },
            { value: 'upper', label: 'UPPER' }, { value: 'title', label: 'Title' },
          ]}
        />
      </div>
      <Preview op={op} values={values} distinct={known?.distinct} />
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
function MergeFields({ op, onChange, known, viewId }: {
  op: OpDraft; onChange: (p: Partial<OpDraft>) => void; known: SearchCatalogProperty | null; viewId: string
}) {
  const all = useAllValues(viewId, op.key.trim())
  const values = useMemo(() => all.values ?? known?.values ?? [], [all.values, known?.values])
  // A merge asked for from the catalog (its value bars' "Merge into…") is the first group, kept.
  const [asked] = useState(() => askedGroup(op.map ?? [], values))
  const groups = useMemo(() => {
    const suggested = similarGroups(values)
    if (!asked) return suggested
    const taken = new Set(asked.members.map((m) => key(m)))
    return [asked, ...suggested.filter((g) => !g.members.some((m) => taken.has(key(m))))]
  }, [values, asked])
  // Each group: the member kept (an index into it), or null when it is left out. Asked for: only
  // that group, to begin with; otherwise every suggestion.
  const [choice, setChoice] = useState<Record<string, number | null>>({})
  const picked = (g: SimilarGroup) => (g.key in choice ? choice[g.key]! : asked && g !== asked ? null : g.canonical)
  const map = useMemo(() => mergeMap(groups.flatMap((g) => {
    const c = picked(g)
    return c === null ? [] : [{ members: g.members, canonical: c }]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [groups, choice])
  useEffect(() => {
    if (JSON.stringify(map) !== JSON.stringify(op.map ?? [])) onChange({ map })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  const tooMany = known && !known.distinctExact && known.values.length === 0
  if (tooMany) {
    return <Hint>It holds more than {known.distinct.toLocaleString()} distinct values — too many to list and merge here. Use Find &amp; replace with “Whole value only” instead.</Hint>
  }
  if (all.loading && values.length === 0) return <div className="space-y-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full rounded-lg" />)}</div>
  const entities = map.reduce((n, m) => n + (values.find((v) => key(v) === key({ value: m.from, kind: m.fromKind ?? '' }))?.count ?? 0), 0)
  return (
    <div className="space-y-3">
      {groups.length === 0 ? (
        <Hint>
          None of its {values.length.toLocaleString()} values differ only in case or in spaces around them. To merge other values,
          select them in the property’s values on the Properties tab and choose <span className="font-semibold">Merge into…</span>
        </Hint>
      ) : (
        <>
          <p className="text-[11.5px] text-ink-muted">
            {asked ? 'The values you chose, and others' : 'Values'} that read as one once case and spaces are set aside — pick the one to keep.
            {all.loading && ' Reading every value it holds…'}
          </p>
          <ul className="max-h-72 space-y-1.5 overflow-y-auto custom-scrollbar pr-0.5" aria-label="Values to merge">
            {groups.map((g) => {
              const c = picked(g)
              const total = g.members.reduce((n, m) => n + m.count, 0)
              return (
                <li key={g.key} className={cn('rounded-lg border p-2', c !== null ? 'border-accent-lineage/30 bg-accent-lineage/[0.04]' : 'border-black/[0.07] dark:border-white/[0.08]')}>
                  <label className="flex items-center gap-2 text-[12px] text-ink">
                    <input type="checkbox" className="accent-indigo-500" checked={c !== null}
                      onChange={(e) => setChoice((s) => ({ ...s, [g.key]: e.target.checked ? g.canonical : null }))} />
                    <span className="flex-1 min-w-0 truncate">
                      {g.members.length} values → <span className="font-mono">{quote(g.members[c ?? g.canonical]!.value)}</span>
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-ink-muted">{total.toLocaleString()}</span>
                  </label>
                  <div role="radiogroup" aria-label={`Keep which of ${g.members.length} values`} className="mt-1 pl-6 space-y-0.5">
                    {g.members.map((m, i) => (
                      <label key={key(m)} className="flex items-center gap-2 text-[11.5px] text-ink-secondary">
                        <input type="radio" name={`keep-${g.key}`} className="accent-indigo-500" checked={(c ?? g.canonical) === i}
                          onChange={() => setChoice((s) => ({ ...s, [g.key]: i }))} aria-label={`Keep ${quote(m.value)}`} />
                        <span className="flex-1 min-w-0 truncate font-mono whitespace-pre">{quote(m.value)}</span>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-ink-muted">{m.count.toLocaleString()}</span>
                      </label>
                    ))}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="text-[11.5px] text-ink-secondary" aria-live="polite">
            {map.length === 0 ? 'Nothing chosen to merge.'
              : <>Merges <span className="font-semibold tabular-nums">{map.length.toLocaleString()}</span> value{map.length === 1 ? '' : 's'} into another — held by about <span className="tabular-nums">{entities.toLocaleString()}</span> entities in this view.</>}
          </p>
        </>
      )}
      <Toggle label="In lists, each value once" checked={op.dedupeList ?? true} onChange={(dedupeList) => onChange({ dedupeList })}
        detail="A list holding two of the merged values keeps one" />
    </div>
  )
}

const key = (v: { value: unknown; kind: string }) => JSON.stringify([v.kind, v.value])

/** The group a merge asked for from the catalog names: what it merges, and what into. */
function askedGroup(map: NonNullable<OpDraft['map']>, values: readonly SearchCatalogValue[]): SimilarGroup | null {
  if (map.length === 0) return null
  const count = (value: unknown, kind: string) => values.find((v) => key(v) === key({ value, kind }))?.count ?? 0
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

function ConvertFields({ op, onChange, known, viewId }: {
  op: OpDraft; onChange: (p: Partial<OpDraft>) => void; known: SearchCatalogProperty | null; viewId: string
}) {
  const all = useAllValues(viewId, op.key.trim())
  const values = all.values ?? known?.values ?? []
  const kinds = Object.entries(known?.kinds ?? {}).sort((a, b) => b[1] - a[1])
  const fails = op.toKind ? values.filter((v) => cleanValue({ ...op, onFail: 'skip' }, v.value, v.kind).fails) : []
  return (
    <div className="space-y-3">
      {kinds.length > 0 && (
        <p className="text-[11.5px] text-ink-secondary">
          Stored as {kinds.map(([kind, n], i) => (
            <span key={kind}>
              {i > 0 && (i === kinds.length - 1 ? ' and ' : ', ')}
              <span className="font-semibold">{VALUE_KIND_LABEL[kind as ValueKind] ?? kind}</span> on <span className="tabular-nums">{n.toLocaleString()}</span>
            </span>
          ))} entities in this view.
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
          <Preview op={{ ...op, onFail: 'skip' }} values={values.filter((v) => !fails.includes(v))} distinct={known?.distinct} title="Converts" />
          {fails.length > 0 ? (
            <fieldset className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
              <legend className="px-1 text-[11px] text-amber-700 dark:text-amber-300">
                {fails.length.toLocaleString()} value{fails.length === 1 ? '' : 's'} won’t convert to {VALUE_KIND_LABEL[op.toKind]} — held by{' '}
                {fails.reduce((n, v) => n + v.count, 0).toLocaleString()} entities in this view:
              </legend>
              <ul className="mb-1.5 flex flex-wrap gap-1" aria-label="Values that won’t convert">
                {fails.slice(0, 12).map((v) => (
                  <li key={key(v)} className="inline-flex items-center gap-1 rounded-md bg-black/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary dark:bg-white/[0.06]">
                    <span className="whitespace-pre">{quote(v.value)}</span>
                    <span className="tabular-nums text-ink-muted">{v.count.toLocaleString()}</span>
                  </li>
                ))}
                {fails.length > 12 && <li className="self-center text-[11px] text-ink-muted">and {(fails.length - 12).toLocaleString()} more</li>}
              </ul>
              {(['skip', 'remove'] as const).map((choice) => (
                <label key={choice} className="flex items-center gap-2 py-0.5 text-[12px] text-ink">
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
/** Before → after for the values listed that the clean-up changes, the most held first. */
function Preview({ op, values, distinct, title = 'Changes' }: {
  op: OpDraft; values: readonly SearchCatalogValue[]; distinct?: number; title?: string
}) {
  const changed = values.map((v) => ({ v, out: cleanValue(op, v.value, v.kind) })).filter((r) => r.out.changed)
  if (values.length === 0) return <Hint>This view’s entities hold none of its values yet, so there is nothing to preview.</Hint>
  const entities = changed.reduce((n, r) => n + r.v.count, 0)
  const of = distinct !== undefined && distinct > values.length ? ` of the ${values.length.toLocaleString()} most held` : ''
  return (
    <div>
      <span className={LABEL}>{title}</span>
      {changed.length === 0 ? (
        <p className="text-[11.5px] text-ink-muted">None of the values{of} would change.</p>
      ) : (
        <>
          <ul className="space-y-1" aria-label="Before and after">
            {changed.slice(0, SHOWN).map(({ v, out }) => (
              <li key={key(v)} className="flex items-center gap-1.5 text-[11.5px]">
                <span className="min-w-0 truncate rounded bg-rose-500/[0.06] px-1.5 py-0.5 font-mono whitespace-pre text-ink-secondary">{quote(v.value)}</span>
                <ArrowRight className="h-3 w-3 shrink-0 text-ink-muted" aria-hidden />
                <span className="min-w-0 truncate rounded bg-emerald-500/[0.08] px-1.5 py-0.5 font-mono whitespace-pre text-ink">
                  {out.value === undefined ? <span className="italic font-sans">removed</span> : quote(out.value)}
                </span>
                <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-ink-muted">{v.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-ink-muted">
            {changed.length.toLocaleString()} value{changed.length === 1 ? '' : 's'}{of} change — on{' '}
            <span className="tabular-nums">{entities.toLocaleString()}</span> entities in this view
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
    <label className="inline-flex items-center gap-2 py-0.5 text-[12px] text-ink">
      <input type="checkbox" className="accent-indigo-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{detail && <span className="text-ink-muted"> — {detail}</span>}</span>
    </label>
  )
}

function Hint({ children, tone }: { children: ReactNode; tone?: 'warning' }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-[11px] leading-snug', tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-ink-muted')}>
      <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}
