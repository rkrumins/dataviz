/**
 * ScopePicker — "where does it go?" for the builder rail and Build: the scope's own parents first
 * (a layer's entities, or what can hold the type asked for), the rest of the canvas when searched,
 * and the top level.
 *
 * Fast on a canvas of thousands: the candidates are listed once when it opens (one pass over the
 * canvas, a lookup per node), and a keystroke filters that list, stopping at what it shows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { usePersonaMode } from '@/store/persona'
import type { LineageNode } from '@/store/canvas'
import type { EntityTypeSchema } from '@/types/schema'
import type { ScopeNode } from './resolveCreationScope'

/** How many of the rest of the canvas a search shows. */
const ELSEWHERE_LIMIT = 30
/** How many it lists with no search and no scope of its own (a row's "+", a node's menu). */
const UNSCOPED_LIMIT = 100

export interface ScopeOption {
  urn: string
  name: string
  typeId: string
}

/** The ontology-coloured chip shown wherever a type appears. */
export function ScopeTypeChip({ type }: { type?: EntityTypeSchema }) {
  const color = type?.visual?.color
  return (
    <span className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}20`, color }}>
      <DynamicIcon name={type?.visual?.icon ?? 'Box'} className="w-2.5 h-2.5" />
    </span>
  )
}

/** An entity's name as the current view shows it. */
export function useScopeName() {
  const persona = usePersonaMode()
  return useCallback((node: LineageNode | undefined, fallback: string) =>
    resolveEntityName(node?.data as Parameters<typeof resolveEntityName>[0], persona, fallback), [persona])
}

/** 'a' or 'an', for "an App". */
export const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a')

export function ScopePickerPopover({
  nodes, typeById, canHold, choices, choicesLabel, topLevel, selectedUrn, emptyText, onPick, onClose,
}: {
  nodes: LineageNode[]
  typeById: Map<string, EntityTypeSchema>
  /** May something be added inside an entity of this type (of the type asked for, when one is)? */
  canHold: (typeId: string) => boolean
  /** The scope's own parents, listed first. */
  choices: readonly ScopeNode[]
  /** Their heading ("In Domains"). */
  choicesLabel?: string
  /** The top level, as an option of its own (its label says what it adds). */
  topLevel?: { label: string; typeId?: string | null; onPick: () => void } | null
  /** Where things go now, ticked. */
  selectedUrn?: string | null
  /** Said when nothing can hold what is being added. */
  emptyText?: string
  onPick: (urn: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const nameOf = useScopeName()
  useDismiss(ref, onClose)
  useEffect(() => { searchRef.current?.focus() }, [])

  // Every candidate on the canvas, once per open (and per change to the canvas while open).
  const all = useMemo(() => {
    const out: ScopeOption[] = []
    const byUrn = new Map<string, ScopeOption>()
    for (const n of nodes) {
      const typeId = n.data?.type as string
      if (!typeId || !canHold(typeId)) continue
      const urn = (n.data?.urn as string) || n.id
      if (byUrn.has(urn)) continue
      const o = { urn, name: nameOf(n, (n.data?.label as string) || n.id), typeId }
      byUrn.set(urn, o)
      out.push(o)
    }
    return { out, byUrn }
  }, [nodes, canHold, nameOf])

  const query = q.trim().toLowerCase()
  const matches = (o: ScopeOption) => !query || o.name.toLowerCase().includes(query)
  const scoped = useMemo(() => choices.map((c) => all.byUrn.get(c.urn)).filter((o): o is ScopeOption => !!o), [choices, all])
  const shownScoped = scoped.filter(matches)
  const scopedUrns = new Set(scoped.map((o) => o.urn))
  // The rest of the canvas: when searched — or, with no scope of its own, the first of it.
  let elsewhere: ScopeOption[] = []
  let elsewhereMore = 0
  if (query || scoped.length === 0) {
    const limit = query ? ELSEWHERE_LIMIT : UNSCOPED_LIMIT
    for (const o of all.out) {
      if (scopedUrns.has(o.urn) || !matches(o)) continue
      if (elsewhere.length < limit) elsewhere.push(o)
      else { elsewhereMore++; if (query) break }
    }
  }
  const showTop = !!topLevel && (!query || topLevel.label.toLowerCase().includes(query))
  const items: Array<{ key: string; pick: () => void }> = [
    ...shownScoped.map((o) => ({ key: o.urn, pick: () => onPick(o.urn) })),
    ...elsewhere.map((o) => ({ key: o.urn, pick: () => onPick(o.urn) })),
    ...(showTop ? [{ key: '__top__', pick: () => topLevel!.onPick() }] : []),
  ]
  const active = Math.min(hi, items.length - 1)

  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(i + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.pick() }
  }

  const row = (o: ScopeOption, i: number) => {
    const type = typeById.get(o.typeId)
    return (
      <button
        key={o.urn}
        type="button"
        role="option"
        aria-selected={o.urn === selectedUrn}
        data-highlighted={i === active || undefined}
        onClick={() => onPick(o.urn)}
        onMouseMove={() => setHi(i)}
        className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
          i === active ? 'bg-accent-lineage/10' : 'hover:bg-black/5 dark:hover:bg-white/5')}
      >
        <ScopeTypeChip type={type} />
        <span className="flex-1 min-w-0 text-sm text-ink truncate">{o.name}</span>
        <span className="text-[10px] text-ink-muted flex-shrink-0">{type?.name ?? o.typeId}</span>
        {o.urn === selectedUrn && <LucideIcons.Check className="w-3.5 h-3.5 text-accent-lineage flex-shrink-0" />}
      </button>
    )
  }
  const heading = (text: string) => (
    <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{text}</div>
  )

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.97, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: -4 }}
      transition={{ duration: 0.12 }}
      className="absolute left-0 right-0 top-full mt-1 z-50 bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-xl shadow-lg overflow-hidden"
    >
      <div className="p-2 border-b border-glass-border">
        <div className="relative">
          <LucideIcons.Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
          <input
            ref={searchRef} value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0) }}
            onKeyDown={onKeyDown}
            placeholder="Search where to add…"
            aria-label="Search where to add"
            className="input w-full pl-8 text-sm"
          />
        </div>
      </div>
      <div ref={listRef} role="listbox" aria-label="Where to add" className="max-h-[280px] overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
        {shownScoped.length > 0 && (
          <>
            {choicesLabel && heading(choicesLabel)}
            {shownScoped.map((o, i) => row(o, i))}
          </>
        )}
        {elsewhere.length > 0 && (
          <>
            {scoped.length > 0 && heading('Elsewhere on the canvas')}
            {elsewhere.map((o, j) => row(o, shownScoped.length + j))}
            {elsewhereMore > 0 && (
              <div className="px-2 py-1 text-[10px] text-ink-muted">
                {query ? 'More match — keep typing to narrow' : `${elsewhereMore} more — type to search`}
              </div>
            )}
          </>
        )}
        {shownScoped.length === 0 && elsewhere.length === 0 && (
          <div className="text-center py-4 text-[11px] text-ink-muted">
            {query ? 'Nothing matches.' : (emptyText ?? 'Nothing on the canvas can hold more.')}
          </div>
        )}
        {showTop && (() => {
          const i = items.length - 1
          return (
            <div className={cn(items.length > 1 && 'mt-1 pt-1 border-t border-glass-border')}>
              <button
                type="button"
                role="option"
                aria-selected={selectedUrn === null}
                data-highlighted={i === active || undefined}
                onClick={() => topLevel!.onPick()}
                onMouseMove={() => setHi(i)}
                className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                  i === active ? 'bg-accent-lineage/10' : 'hover:bg-black/5 dark:hover:bg-white/5')}
              >
                {topLevel!.typeId ? <ScopeTypeChip type={typeById.get(topLevel!.typeId)} /> : (
                  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-ink-muted"><LucideIcons.Globe className="w-3 h-3" /></span>
                )}
                <span className="flex-1 min-w-0 text-sm text-ink truncate">{topLevel!.label}</span>
                {selectedUrn === null && <LucideIcons.Check className="w-3.5 h-3.5 text-accent-lineage flex-shrink-0" />}
              </button>
            </div>
          )
        })()}
      </div>
    </motion.div>
  )
}

/** Dismiss on outside-click + Escape (matches EdgeTypePickerPopover). */
export function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(t); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [ref, onClose])
}
