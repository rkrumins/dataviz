/**
 * LineageLens — the focus room over the canvas.
 *
 * A near-fullscreen modal that opens on one entity and answers "what
 * feeds it, what consumes it, and what does it contain" — walkable one
 * hop at a time in either axis, however deep the estate goes. The body
 * is the interactive graph (LensGraphView); this shell owns only the
 * chrome: the walk trail with browser-style Back/Forward, the share
 * link, the trace escalation, and the curated-view external preview.
 *
 * All data flows through useLensSession (one hook, server-fed,
 * lens-local); the shell never touches the canvas store. Strictly a
 * way of LOOKING — nothing in here mutates graph data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, Link2, Radar, X } from 'lucide-react'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { LensGraphView } from './lens/LensGraphView'
import { useLensSession } from './lens/useLensSession'
import {
  lensBackward,
  lensFocalOf,
  lensForwardStep,
  lensJump,
  lensPush,
  type LensHistory,
} from './lens/lensHistory'
import { encodeLensShare, type LensShareState } from './lens/shareCodec'

export interface LineageLensProps {
  /** Walk history; empty entries = closed. */
  history: LensHistory
  onHistoryChange: (next: LensHistory) => void
  onClose: () => void
  /** Reveal the node on the canvas (expand ancestors + scroll) without closing the lens. */
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  /** Open the entity drawer for a node. */
  onOpenDetails?: (nodeId: string) => void
  /** Escalate to a full server trace from the focal node (closes the lens). */
  onTrace?: (nodeId: string) => void
  /** Feature-flagged out-of-view preview for the focal node: partners
   *  that exist in the data source but are outside this view's scope.
   *  Advisory only — never part of the canvas. */
  externalPreview?: {
    loading: boolean
    records: Array<{ urn: string; label: string; direction: 'in' | 'out'; edgeType: string }>
  } | null
  /** Gestures decoded from a share link, replayed once on the restored
   *  focal so the receiving lens shows the shared picture. */
  shareSeed?: LensShareState | null
}

export function LineageLens({
  history,
  onHistoryChange,
  onClose,
  onRevealOnCanvas,
  onOpenDetails,
  onTrace,
  externalPreview,
  shareSeed,
}: LineageLensProps) {
  const provider = useGraphProviderIfAvailable()
  const focal = lensFocalOf(history)
  const session = useLensSession(focal, provider)
  const open = focal !== null

  // ── Keyboard: Esc closes, ←/→ retrace the walk ──────────────────────
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onHistoryChange(lensBackward(history))
      else if (e.key === 'ArrowRight') onHistoryChange(lensForwardStep(history))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, history, onHistoryChange, onClose])

  // ── Share-link replay: fire the shared gestures once per seed ───────
  const seedConsumedRef = useRef(false)
  useEffect(() => {
    if (!shareSeed || seedConsumedRef.current) return
    if (!session || session.state.focal !== shareSeed.entries[shareSeed.cursor]) return
    seedConsumedRef.current = true
    for (const key of shareSeed.expansions) {
      const sep = key.indexOf(':')
      if (sep <= 0) continue
      const dir = key.slice(0, sep)
      if (dir === 'up' || dir === 'down') session.expandLineage(dir, key.slice(sep + 1))
    }
    for (const urn of shareSeed.children) session.openChildren(urn)
  }, [shareSeed, session])
  // Drills replay once their record exists (a shared drill needs the
  // expansion that revealed the record to land first).
  const seededDrillsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!shareSeed || !session) return
    for (const recordId of shareSeed.drills) {
      if (seededDrillsRef.current.has(recordId)) continue
      const record = session.state.records.get(recordId)
      if (record?.rollupEdge) {
        seededDrillsRef.current.add(recordId)
        session.drillRollup(recordId, record.rollupEdge.targetUrn)
      }
    }
  }, [shareSeed, session])

  // ── Share: encode the current exploration as a link ─────────────────
  const [copied, setCopied] = useState(false)
  const share = useCallback(() => {
    if (!session) return
    const token = encodeLensShare({
      entries: history.entries,
      cursor: history.cursor,
      expansions: [...session.state.expansions.keys()],
      children: [...session.state.children.keys()],
      drills: [...session.state.drills.keys()],
    })
    const url = `${window.location.origin}${window.location.pathname}?lens=${token}${window.location.hash}`
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }, [session, history])

  const labelFor = useCallback(
    (urn: string) =>
      session?.state.nodes.get(urn)?.displayName ||
      urn.split(/[:/.]/).filter(Boolean).pop() ||
      urn,
    [session],
  )

  const trail = useMemo(
    () => history.entries.map((urn, index) => ({ urn, index, ahead: index > history.cursor })),
    [history],
  )

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[9990]" role="dialog" aria-modal="true" aria-label="Lineage Lens">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="absolute inset-4 flex flex-col overflow-hidden rounded-xl border border-black/10 dark:border-white/10 bg-canvas shadow-2xl md:inset-8">
        {/* Header: walk controls, trail, share, close. */}
        <div className="flex items-center gap-2 border-b border-black/10 dark:border-white/10 bg-canvas-elevated px-3 py-2">
          <button
            type="button"
            className="rounded p-1 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5 disabled:opacity-30"
            onClick={() => onHistoryChange(lensBackward(history))}
            disabled={history.cursor <= 0}
            title="Back (←)"
            aria-label="Back"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5 disabled:opacity-30"
            onClick={() => onHistoryChange(lensForwardStep(history))}
            disabled={history.cursor >= history.entries.length - 1}
            title="Forward (→)"
            aria-label="Forward"
          >
            <ArrowRight size={14} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap px-1 text-2xs">
            {trail.map(step => (
              <span key={`${step.index}:${step.urn}`} className="flex items-center gap-1">
                {step.index > 0 ? <span className="text-ink-muted/50" aria-hidden>›</span> : null}
                <button
                  type="button"
                  onClick={() => onHistoryChange(lensJump(history, step.index))}
                  className={`max-w-[180px] truncate rounded-full border px-2 py-0.5 ${
                    step.index === history.cursor
                      ? 'border-accent-lineage text-accent-lineage'
                      : step.ahead
                        ? 'border-black/10 text-ink-muted/50 dark:border-white/10'
                        : 'border-black/10 text-ink-muted hover:text-ink dark:border-white/10'
                  }`}
                  title={step.urn}
                >
                  {labelFor(step.urn)}
                </button>
              </span>
            ))}
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-black/10 dark:border-white/10 px-2 py-1 text-2xs text-ink-muted hover:text-ink"
            onClick={share}
            title="Copy a link that reopens this exact exploration"
          >
            {copied ? <Check size={12} className="text-green-600" aria-hidden /> : <Link2 size={12} aria-hidden />}
            {copied ? 'Copied' : 'Share'}
          </button>
          {onTrace && focal ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-black/10 dark:border-white/10 px-2 py-1 text-2xs text-ink-muted hover:text-ink"
              onClick={() => {
                onTrace(focal)
                onClose()
              }}
              title="Hand off to a full lineage trace on the canvas"
            >
              <Radar size={12} aria-hidden /> Trace from here
            </button>
          ) : null}
          <button
            type="button"
            className="rounded p-1 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close lens"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body: the interactive graph, keyed so per-focal presentation
            state (paging, selection, camera) resets by construction. */}
        <div className="min-h-0 flex-1">
          {session ? (
            <LensGraphView
              key={session.state.focal}
              session={session}
              onFocus={urn => onHistoryChange(lensPush(history, urn))}
              {...(onRevealOnCanvas ? { onRevealOnCanvas: (urn: string) => void onRevealOnCanvas(urn) } : {})}
              {...(onOpenDetails ? { onOpenDetails } : {})}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-ink-muted">
              No graph provider available.
            </div>
          )}
        </div>

        {/* Curated-view external preview — advisory, never on canvas. */}
        {externalPreview && (externalPreview.loading || externalPreview.records.length > 0) ? (
          <div className="flex items-center gap-2 overflow-x-auto border-t border-black/10 dark:border-white/10 bg-canvas-elevated px-3 py-1.5 text-2xs text-ink-muted">
            <span className="shrink-0 font-medium">Outside this view:</span>
            {externalPreview.loading ? (
              <span>measuring…</span>
            ) : (
              externalPreview.records.slice(0, 12).map(r => (
                <span
                  key={`${r.direction}:${r.urn}`}
                  className="shrink-0 rounded-full border border-black/10 dark:border-white/10 px-2 py-0.5"
                  title={`${r.direction === 'in' ? 'Upstream' : 'Downstream'} · ${r.edgeType}`}
                >
                  {r.direction === 'in' ? '↑' : '↓'} {r.label}
                </span>
              ))
            )}
            {!externalPreview.loading && externalPreview.records.length > 12 ? (
              <span className="shrink-0">+{externalPreview.records.length - 12} more</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
