/**
 * CreateLinkPopover — the click-based "Link to…" lineage-connect flow.
 *
 * The discoverable sibling of the drag-only EdgeTypePickerPopover: a node's
 * "Link to…" action (context menu / builder row) opens this glass popover at the
 * click point. Step 1 picks a TARGET from the canvas nodes; step 2 picks the
 * ontology-allowed lineage relationship (auto-selected when only one is valid,
 * radio cards when several, a plain-language explainer when none). Confirm stages
 * a RAW create_edge via the `onCreateLink` prop — everything else comes from
 * {@link useCreateLinkStore}, whose `open()` runs the draft guard.
 *
 * Ontology-driven throughout: connectable types + their humanized disabled
 * reasons come from `deriveConnectableEdges`; every type renders its icon/color.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useViewEntityTypes, useViewRelationshipTypes, useViewContainmentEdgeTypes } from '@/hooks/useViewSchema'
import { deriveConnectableEdges, connectedEdgeTypes, type AllowedEdgeOption } from '@/services/ontologyPreflightService'
import { relationshipLabel } from '@/lib/relationshipLabel'
import { useToast } from '@/components/ui/toast'
import type { EntityTypeSchema } from '@/types/schema'
import { useCreateLinkStore } from './createLinkStore'

export interface CreateLinkPopoverProps {
  /** Stage a RAW lineage edge (source urn → target urn) of the chosen type.
   *  Returns the staged temp edge id, or `null` when the ontology gate rejects
   *  it (the gate shows its own error toast). */
  onCreateLink: (sourceUrn: string, targetUrn: string, edgeType: string) => string | null
}

/** The duplicate-disable reason (mirrors EdgeTypePickerPopover's wording). */
const ALREADY_CONNECTED = 'Already connected by this relationship.'

/** Prefer the ontology's human label; fall back to a humanized id. Never a raw id. */
function relationshipText(o: AllowedEdgeOption): string {
  return o.label && o.label !== o.edgeType ? o.label : relationshipLabel(o.edgeType)
}

function DynamicIcon({ name, className }: { name?: string; className?: string }) {
  const Icon = name
    ? (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
    : undefined
  if (!Icon) return <LucideIcons.Box className={className} />
  return <Icon className={className} />
}

/** The ontology-colored icon chip shown wherever a type appears. */
function TypeChip({ type }: { type?: EntityTypeSchema }) {
  const color = type?.visual?.color
  return (
    <span
      className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: `${color}20`, color }}
    >
      <DynamicIcon name={type?.visual?.icon} className="w-3.5 h-3.5" />
    </span>
  )
}

export function CreateLinkPopover({ onCreateLink }: CreateLinkPopoverProps) {
  const isOpen = useCreateLinkStore((s) => s.isOpen)
  const sourceUrn = useCreateLinkStore((s) => s.sourceUrn)
  const anchor = useCreateLinkStore((s) => s.anchor)
  const close = useCreateLinkStore((s) => s.close)

  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const entityTypes = useViewEntityTypes()
  const relationshipTypes = useViewRelationshipTypes()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()
  const { showToast } = useToast()

  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [targetUrn, setTargetUrn] = useState<string | null>(null)
  const [selectedEdgeType, setSelectedEdgeType] = useState<string | null>(null)

  const typeById = useMemo(() => new Map(entityTypes.map((t) => [t.id, t])), [entityTypes])

  const sourceNode = useMemo(
    () => nodes.find((n) => n.id === sourceUrn || (n.data?.urn as string) === sourceUrn),
    [nodes, sourceUrn],
  )
  const sourceType = (sourceNode?.data?.type as string) ?? null
  const sourceName = (sourceNode?.data?.label as string) ?? sourceUrn ?? ''
  const sourceTypeSchema = sourceType ? typeById.get(sourceType) : undefined

  // Reset to the target step each time the popover (re)opens for a source.
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setHighlighted(0)
      setTargetUrn(null)
      setSelectedEdgeType(null)
    }
  }, [isOpen, sourceUrn])

  // Self-heal: if the popover is "open" but can no longer render (the
  // source node vanished from the canvas store after a reload / branch
  // switch), close it. Otherwise the component returns null below while
  // the store stays open — leaving the CAPTURE-phase Escape swallower
  // armed (eating Escape for every drawer/menu app-wide) and the
  // outside-click closer dead (ref.current is null), with nothing
  // visible to dismiss. Only a refresh recovers from that state.
  useEffect(() => {
    if (isOpen && (!sourceUrn || !sourceNode || !anchor)) close()
  }, [isOpen, sourceUrn, sourceNode, anchor, close])

  // Autofocus the search input while on the target step.
  useEffect(() => {
    if (!isOpen || targetUrn) return
    const t = window.setTimeout(() => searchRef.current?.focus(), 20)
    return () => window.clearTimeout(t)
  }, [isOpen, targetUrn])

  // Target candidates: every canvas node (visible + staged) except the source,
  // filtered by name or type name as the user types.
  const targets = useMemo(() => {
    const list = nodes
      .filter((n) => (n.data?.urn as string) !== sourceUrn && n.id !== sourceUrn)
      .map((n) => ({
        urn: (n.data?.urn as string) || n.id,
        name: (n.data?.label as string) || n.id,
        typeId: (n.data?.type as string) || '',
      }))
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (o) => o.name.toLowerCase().includes(q) || (typeById.get(o.typeId)?.name ?? o.typeId).toLowerCase().includes(q),
    )
  }, [nodes, sourceUrn, query, typeById])

  const targetNode = useMemo(
    () => nodes.find((n) => n.id === targetUrn || (n.data?.urn as string) === targetUrn),
    [nodes, targetUrn],
  )
  const targetType = (targetNode?.data?.type as string) ?? null
  const targetName = (targetNode?.data?.label as string) ?? targetUrn ?? ''

  // Link-type options for the chosen pair (drawable lineage). Types already
  // connecting this exact source→target are disabled (mirrors EdgeTypePickerPopover)
  // so confirm can never stage a duplicate. `allOptions` keeps the disabled ones so
  // the zero-options state can explain what WOULD work.
  const allOptions = useMemo(
    () => {
      if (!targetUrn) return []
      const connected = connectedEdgeTypes(edges, sourceUrn ?? undefined, targetUrn)
      return deriveConnectableEdges(sourceType, targetType, relationshipTypes, containmentEdgeTypes, entityTypes)
        .map((o) =>
          connected.has(o.edgeType.toUpperCase())
            ? { ...o, allowed: false, reason: ALREADY_CONNECTED }
            : o,
        )
    },
    [targetUrn, sourceUrn, edges, sourceType, targetType, relationshipTypes, containmentEdgeTypes, entityTypes],
  )
  const options = useMemo(() => allOptions.filter((o) => o.allowed), [allOptions])
  // Zero-state flavor: every ontology-valid type is blocked only because it already
  // connects this pair → say "already linked" (and drop the now-redundant bullet).
  const alreadyLinked = options.length === 0 && allOptions.some((o) => o.reason === ALREADY_CONNECTED)
  const disabledReasons = useMemo(
    () => {
      const reasons = [...new Set(allOptions.filter((o) => !o.allowed && o.reason).map((o) => o.reason as string))]
      return (alreadyLinked ? reasons.filter((r) => r !== ALREADY_CONNECTED) : reasons).slice(0, 2)
    },
    [allOptions, alreadyLinked],
  )

  // Default the radio selection to the first allowed type when the pair changes.
  useEffect(() => {
    setSelectedEdgeType(options[0]?.edgeType ?? null)
  }, [targetUrn, options])

  const chosenEdgeType = options.length >= 2 ? selectedEdgeType : (options[0]?.edgeType ?? null)

  // Dismiss: outside-click closes; Escape steps back from the link step, else closes.
  // Escape is intercepted in the CAPTURE phase with stopPropagation: the canvases'
  // useCanvasKeyboard listens on document in the bubble phase with no input-guard
  // for buttons, so an un-stopped Escape would fire the canvas onCancel — which can
  // close the Hierarchy Builder underneath a builder-row-initiated link. Capture
  // runs first and stops the event before that listener (and before anything else)
  // ever sees it, wherever focus happens to be.
  useEffect(() => {
    if (!isOpen) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      if (targetUrn) setTargetUrn(null)
      else close()
    }
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [isOpen, targetUrn, close])

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((i) => Math.min(i + 1, targets.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (targets[highlighted]) setTargetUrn(targets[highlighted].urn)
    }
  }

  // Keep the highlighted target row scrolled into view.
  useEffect(() => {
    listRef.current?.querySelector('[data-hl="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, targets.length])

  const confirm = useCallback(() => {
    if (!sourceUrn || !targetUrn || !chosenEdgeType) return
    // stageEdgeCreate returns null when its ontology gate rejects (it toasts
    // its own error) — only claim success for an actually-staged edge.
    const staged = onCreateLink(sourceUrn, targetUrn, chosenEdgeType)
    if (staged !== null) {
      showToast('success', `Linked ${sourceName} → ${targetName} — save when you're done`)
    }
    close()
  }, [sourceUrn, targetUrn, chosenEdgeType, onCreateLink, showToast, sourceName, targetName, close])

  if (!isOpen || !sourceUrn || !sourceNode || !anchor) return null

  // Keep the popover on-screen near the anchor point.
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - 320))
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 440))

  return (
    <motion.div
      ref={ref}
      // Enter must never leak to useCanvasKeyboard's document listener: its
      // input-guard passes buttons through, and it preventDefaults Enter (killing
      // the focused "Create link" activation) then fires onEdit on the source
      // node. Stopping propagation here ends the event at the React root, before
      // it bubbles on to document — the button's default activation still runs.
      onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation() }}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed z-[210] w-[300px] bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-2xl shadow-lg overflow-hidden"
      style={{ left, top }}
    >
      {/* Header — the source, by icon + name. */}
      <div className="px-4 py-3 border-b border-glass-border flex items-center gap-2">
        <TypeChip type={sourceTypeSchema} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink truncate">Link {sourceName}</h3>
          <p className="text-[10px] text-ink-muted truncate">
            {targetUrn ? <>to <span className="text-ink">{targetName}</span></> : 'Choose what to link it to'}
          </p>
        </div>
        <button
          onClick={close}
          title="Close"
          aria-label="Close"
          className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors flex-shrink-0"
        >
          <LucideIcons.X className="w-4 h-4 text-ink-muted" />
        </button>
      </div>

      {!targetUrn ? (
        /* ── Step 1: target picker ── */
        <>
          <div className="p-2 border-b border-glass-border">
            <div className="relative">
              <LucideIcons.Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setHighlighted(0) }}
                onKeyDown={onSearchKeyDown}
                placeholder="Search entities…"
                className="input w-full pl-8 text-sm"
              />
            </div>
          </div>
          <div ref={listRef} className="max-h-[280px] overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
            {targets.length === 0 && (
              <div className="text-center py-6 text-[11px] text-ink-muted">No other entities on the canvas to link to.</div>
            )}
            {targets.map((o, i) => (
              <button
                key={o.urn}
                data-hl={i === highlighted}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => setTargetUrn(o.urn)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                  i === highlighted ? 'bg-accent-lineage/10' : 'hover:bg-black/5 dark:hover:bg-white/5',
                )}
              >
                <TypeChip type={typeById.get(o.typeId)} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-ink truncate">{o.name}</span>
                  <span className="block text-[10px] text-ink-muted truncate">{typeById.get(o.typeId)?.name ?? o.typeId}</span>
                </span>
                <LucideIcons.ArrowRight className="w-3.5 h-3.5 text-ink-muted/50 flex-shrink-0" />
              </button>
            ))}
          </div>
        </>
      ) : (
        /* ── Step 2: link-type step ── */
        <div className="p-3 space-y-2.5">
          <button
            onClick={() => setTargetUrn(null)}
            className="flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
          >
            <LucideIcons.ChevronLeft className="w-3 h-3" />
            Change target
          </button>

          {options.length === 0 ? (
            /* Plain-language: WHY these two can't link, + what WOULD work. */
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-start gap-2">
              <LucideIcons.AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {alreadyLinked ? 'These two are already linked.' : 'These two can’t be linked.'}
                </p>
                {disabledReasons.length > 0 && (
                  <ul className="mt-1 space-y-1 text-ink-muted">
                    {disabledReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : options.length === 1 ? (
            /* Exactly one valid relationship — auto-selected, shown as a quiet line. */
            <div className="flex items-start gap-2 px-1">
              <LucideIcons.ArrowRight className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-accent-lineage" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink truncate">{relationshipText(options[0])}</div>
                {options[0].description && <div className="text-[10px] text-ink-muted line-clamp-2">{options[0].description}</div>}
              </div>
            </div>
          ) : (
            /* Several valid relationships — radio cards. */
            <div className="space-y-1">
              {options.map((o) => (
                <button
                  key={o.edgeType}
                  type="button"
                  onClick={() => setSelectedEdgeType(o.edgeType)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors',
                    selectedEdgeType === o.edgeType ? 'border-accent-lineage bg-accent-lineage/5' : 'border-glass-border hover:border-ink-muted/50',
                  )}
                >
                  <span className={cn('w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 grid place-items-center', selectedEdgeType === o.edgeType ? 'border-accent-lineage' : 'border-ink-muted/40')}>
                    {selectedEdgeType === o.edgeType && <span className="w-1.5 h-1.5 rounded-full bg-accent-lineage" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink truncate">{relationshipText(o)}</span>
                    {o.description && <span className="block text-[10px] text-ink-muted truncate">{o.description}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}

          {options.length > 0 && (
            <button
              type="button"
              autoFocus
              onClick={confirm}
              disabled={!chosenEdgeType}
              className="w-full px-4 py-2 rounded-lg text-sm font-semibold bg-accent-lineage text-white hover:brightness-110 shadow-sm transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <LucideIcons.Link2 className="w-4 h-4" />
              Create link
            </button>
          )}
        </div>
      )}
    </motion.div>
  )
}

export default CreateLinkPopover
