/**
 * DuplicateDialog — Duplicate… : copy an entity with exactly the relationships
 * the reader chooses, and see what that means before anything is staged.
 *
 * ⌘D keeps the quick copy (the entity, everything inside it, and the edges
 * between them). This is the deliberate one: just the entity, or everything
 * inside it; the edges inside the copy; and — read from the server, not just
 * what the canvas has drawn — the relationships that cross into it (its
 * sources feed the copy too) and out of it (the copy feeds what it feeds).
 * Every count is live, the copy's name is editable, and a copy too big to
 * stage at once is refused in words rather than half made.
 *
 * It is the canvas menu's one Duplicate: it opens on the quick copy's choices
 * with the copy's name in hand, so Enter makes the copy ⌘D would, and anything
 * more is a click away. Tab stays inside it, and focus goes back where it was.
 *
 * Everything lands in the draft as staged changes: Review & Save shows it all,
 * and Undo takes it back.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { Segmented } from '@/components/ui/Segmented'
import { Kbd } from '@/components/ui/Kbd'
import { useModalA11y } from '@/hooks/useModalA11y'
import {
  BOUNDARY_CONFIRM_ABOVE,
  BOUNDARY_MAX,
  DUPLICATE_CONFIRM_ABOVE,
  DUPLICATE_MAX,
  type DuplicateChoice,
  type DuplicateCounts,
  type PreparedDuplicate,
} from '@/hooks/useDuplicateSubtree'

export interface DuplicateDialogProps {
  nodeId: string
  /** Loads the subtree and reads its boundary (useDuplicateSubtree.prepareDuplicate). */
  prepare: (nodeId: string, opts?: { boundary?: boolean }) => Promise<PreparedDuplicate | null>
  /** Stages the choice (useDuplicateSubtree.commitDuplicate). */
  commit: (prepared: PreparedDuplicate, choice: DuplicateChoice) => string | null
  /** The copy is staged: reveal it, and say so. */
  onDone: (originalId: string, rootCopyUrn: string, counts: DuplicateCounts) => void
  onClose: () => void
}

const n = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`

export function DuplicateDialog({ nodeId, prepare, commit, onDone, onClose }: DuplicateDialogProps) {
  const [prepared, setPrepared] = useState<PreparedDuplicate | null>(null)
  const [failed, setFailed] = useState(false)
  const [scope, setScope] = useState<'inside' | 'alone'>('inside')
  const [internal, setInternal] = useState(true)
  const [incoming, setIncoming] = useState(false)
  const [outgoing, setOutgoing] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Tab stays inside, and focus goes back where it came from.
  const panelRef = useModalA11y(true, onClose)
  const nameRef = useRef<HTMLInputElement>(null)

  // Load the subtree and read its boundary once; every count after that is local.
  useEffect(() => {
    let alive = true
    prepare(nodeId, { boundary: true }).then(
      (p) => {
        if (!alive) return
        if (!p) { setFailed(true); return }
        setPrepared(p)
        if (p.descendants === 0) setScope('alone')
      },
      () => { if (alive) setFailed(true) },
    )
    return () => { alive = false }
  }, [nodeId, prepare])

  // Read, it is ready as the quick copy: its name in hand and selected, so Enter makes it
  // and typing renames it — unless the reader has already moved on to a choice.
  useEffect(() => {
    if (!prepared) return
    const active = document.activeElement
    if (active && active !== panelRef.current && active !== document.body) return
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [prepared, panelRef])

  // Escape closes this dialog only — not the drawer or trace behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const withInside = scope === 'inside'
  const choice: DuplicateChoice = { includeDescendants: withInside, internal, incoming, outgoing, name: name ?? undefined }
  const counts = useMemo(
    () => prepared?.count({ includeDescendants: withInside, internal, incoming, outgoing }) ?? null,
    [prepared, withInside, internal, incoming, outgoing],
  )
  // What each relationship toggle would add, whether or not it is on.
  const reach = useMemo(
    () => prepared?.count({ includeDescendants: withInside, internal: true, incoming: true, outgoing: true }) ?? null,
    [prepared, withInside],
  )

  const label = prepared?.label ?? '…'
  const copyName = name ?? (prepared ? `${prepared.label} (Copy)` : '')
  const tooBig = !!prepared && withInside && (prepared.tooBig || (counts?.entities ?? 0) > DUPLICATE_MAX)
  const big = !tooBig && (counts?.entities ?? 0) > DUPLICATE_CONFIRM_ABOVE
  const inOver = !!prepared && (prepared.boundaryCapped.incoming || (reach?.incoming ?? 0) > BOUNDARY_MAX)
  const outOver = !!prepared && (prepared.boundaryCapped.outgoing || (reach?.outgoing ?? 0) > BOUNDARY_MAX)
  const relationships = counts ? counts.internal + counts.incoming + counts.outgoing : 0
  const busyBoundary = counts ? counts.incoming + counts.outgoing > BOUNDARY_CONFIRM_ABOVE : false
  const ready = !!prepared && !!counts && !tooBig && !(incoming && inOver) && !(outgoing && outOver) && copyName.trim().length > 0

  const submit = () => {
    if (!ready || !prepared || !counts) return
    const urn = commit(prepared, { ...choice, name: copyName })
    if (!urn) { setError('The copy could not be staged. Nothing was changed.'); return }
    onDone(nodeId, urn, counts)
    onClose()
  }

  return createPortal(
    <>
      <Backdrop open={true} onClick={onClose} zClassName="z-50" className="bg-black/50 backdrop-blur-sm" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <motion.div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="duplicate-dialog-title"
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className="pointer-events-auto relative w-full max-w-xl rounded-2xl bg-canvas-elevated border border-glass-border shadow-2xl shadow-black/25 overflow-hidden outline-none"
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter from anywhere in it; Enter on the dialog itself, before a choice has focus.
            if (e.key !== 'Enter') return
            if (e.metaKey || e.ctrlKey || e.target === e.currentTarget) { e.preventDefault(); submit() }
          }}
        >
          {/* Header */}
          <div className="flex items-start justify-between px-7 pt-6 pb-4">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="w-11 h-11 rounded-2xl bg-accent-lineage/[0.12] border border-accent-lineage/25 flex items-center justify-center flex-none">
                <LucideIcons.CopyPlus className="w-5 h-5 text-accent-lineage" strokeWidth={2.2} />
              </div>
              <div className="min-w-0">
                <h2 id="duplicate-dialog-title" className="text-xl font-display font-semibold text-ink leading-tight truncate">
                  Duplicate {prepared ? <span className="text-accent-lineage">{label}</span> : '…'}
                </h2>
                <p className="text-[13px] text-ink-muted mt-0.5">Choose what comes with the copy. It lands in your draft beside the original.</p>
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              <LucideIcons.X className="w-5 h-5" />
            </button>
          </div>

          <div className="px-7 pb-6 space-y-5">
            {failed ? (
              <p className="rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[13px] text-red-600 dark:text-red-400">
                This entity couldn&apos;t be read just now, so nothing can be copied. Close this and try again.
              </p>
            ) : (
              <>
                {/* What to copy */}
                <section>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2">What to copy</p>
                  <Segmented
                    label="What to copy"
                    size="md"
                    value={scope}
                    onChange={setScope}
                    options={[
                      { value: 'inside', label: 'With everything inside', icon: LucideIcons.FolderTree, count: prepared ? prepared.descendants + 1 : undefined, disabled: !!prepared && prepared.descendants === 0 },
                      { value: 'alone', label: 'Just this entity', icon: LucideIcons.Box },
                    ]}
                  />
                </section>

                {/* Relationships */}
                <section>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2">Relationships</p>
                  <div className="rounded-xl border border-glass-border/70 divide-y divide-glass-border/60 overflow-hidden">
                    <ToggleRow
                      icon={<LucideIcons.Network className="w-4 h-4" />}
                      title="Links inside the copy"
                      detail="Between the entities copied — recreated between their copies."
                      count={reach?.internal}
                      loading={!prepared}
                      on={internal && withInside}
                      disabled={!withInside || (reach?.internal ?? 0) === 0}
                      why={!withInside ? 'Only with everything inside.' : undefined}
                      onChange={setInternal}
                    />
                    <ToggleRow
                      icon={<LucideIcons.ArrowRightToLine className="w-4 h-4" />}
                      title="Incoming"
                      detail={`What feeds ${label} feeds the copy too.`}
                      count={reach?.incoming}
                      loading={!prepared}
                      capped={prepared?.boundaryCapped.incoming}
                      on={incoming}
                      disabled={inOver || (reach?.incoming ?? 0) === 0}
                      why={inOver ? `More than ${BOUNDARY_MAX} — link them in bulk with Link… instead.` : undefined}
                      onChange={setIncoming}
                    />
                    <ToggleRow
                      icon={<LucideIcons.ArrowRightFromLine className="w-4 h-4" />}
                      title="Outgoing"
                      detail={`The copy feeds what ${label} feeds.`}
                      count={reach?.outgoing}
                      loading={!prepared}
                      capped={prepared?.boundaryCapped.outgoing}
                      on={outgoing}
                      disabled={outOver || (reach?.outgoing ?? 0) === 0}
                      why={outOver ? `More than ${BOUNDARY_MAX} — link them in bulk with Link… instead.` : undefined}
                      onChange={setOutgoing}
                    />
                  </div>
                </section>

                {/* The copy, and what it connects to */}
                <CopyPreview
                  name={copyName}
                  inside={withInside ? Math.max(0, (counts?.entities ?? 1) - 1) : 0}
                  incoming={incoming ? counts?.incoming ?? 0 : 0}
                  outgoing={outgoing ? counts?.outgoing ?? 0 : 0}
                />

                {/* Name */}
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70">Name of the copy</span>
                  <input
                    ref={nameRef}
                    aria-label="Name of the copy"
                    value={copyName}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
                    disabled={!prepared}
                    className="mt-1.5 w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-[14px] text-ink outline-none focus:border-accent-lineage/60 focus:ring-2 focus:ring-accent-lineage/20 transition"
                  />
                </label>

                {/* What will happen — or why it can't */}
                <div aria-live="polite" className="min-h-[20px] text-[13px]">
                  {!prepared ? (
                    <span className="inline-flex items-center gap-2 text-ink-muted">
                      <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Reading {label === '…' ? 'the entity' : label} and its relationships…
                    </span>
                  ) : tooBig ? (
                    <span className="text-red-600 dark:text-red-400">
                      Too big to copy in one go — {prepared.tooBig ? `more than ${DUPLICATE_MAX.toLocaleString()}` : (counts?.entities ?? 0).toLocaleString()} entities. Copy just this entity, or a smaller part.
                    </span>
                  ) : counts ? (
                    <span className={cn('text-ink', (big || busyBoundary) && 'text-amber-700 dark:text-amber-400')}>
                      Creates {n(counts.entities, 'entity', 'entities')}
                      {relationships > 0 && <> and {n(relationships, 'relationship')}</>} in your draft.
                      {(big || busyBoundary) && ' A big copy — check it in Review & Save before saving.'}
                    </span>
                  ) : null}
                  {error && <span className="block mt-1 text-red-600 dark:text-red-400">{error}</span>}
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 px-7 py-4 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
            <p className="hidden sm:flex items-center gap-1.5 min-w-0 text-[11.5px] text-ink-muted">
              <Kbd shortcut="mod+d" />
              <span className="truncate">quick copy, without asking</span>
            </p>
            <div className="flex items-center gap-2 flex-none ml-auto">
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-xl text-[13px] font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!ready}
                className={cn(
                  'h-9 px-4 rounded-xl inline-flex items-center gap-2 text-[13px] font-semibold transition',
                  ready ? 'bg-accent-lineage text-white shadow-sm hover:brightness-110' : 'bg-black/[0.06] dark:bg-white/[0.06] text-ink-muted cursor-not-allowed',
                )}
              >
                <LucideIcons.CopyPlus className="w-4 h-4" />
                Duplicate
                {ready && <Kbd shortcut="mod+enter" tone="onAccent" />}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </>,
    document.body,
  )
}

/** One relationship choice: what it means, how many, and why not when it can't be had. */
function ToggleRow({ icon, title, detail, count, loading, capped, on, disabled, why, onChange }: {
  icon: ReactNode
  title: string
  detail: string
  count?: number
  /** Still reading: a placeholder where the count will be. */
  loading?: boolean
  capped?: boolean
  on: boolean
  disabled?: boolean
  why?: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-accent-lineage/[0.04]',
      )}
    >
      <span className={cn('w-8 h-8 rounded-lg grid place-items-center flex-none', on ? 'bg-accent-lineage/15 text-accent-lineage' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted')}>
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-ink">{title}</span>
          {loading && (
            <span aria-hidden="true" className="w-7 h-[18px] rounded-md bg-black/[0.06] dark:bg-white/[0.08] animate-pulse" />
          )}
          {!loading && count !== undefined && (
            <span className="px-1.5 py-0.5 rounded-md bg-black/[0.05] dark:bg-white/[0.07] text-[11px] font-semibold tabular-nums text-ink-muted">
              {capped ? `${BOUNDARY_MAX.toLocaleString()}+` : count.toLocaleString()}
            </span>
          )}
        </span>
        <span className="block text-[12px] text-ink-muted leading-snug">{why ?? detail}</span>
      </span>
      <span aria-hidden="true" className={cn('relative w-9 h-5 rounded-full flex-none transition-colors', on ? 'bg-accent-lineage' : 'bg-black/15 dark:bg-white/15')}>
        <motion.span
          className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow"
          animate={{ x: on ? 16 : 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        />
      </span>
    </button>
  )
}

/** The copy at the centre, with what will feed it and what it will feed. */
function CopyPreview({ name, inside, incoming, outgoing }: { name: string; inside: number; incoming: number; outgoing: number }) {
  return (
    <div className="rounded-xl border border-dashed border-glass-border bg-black/[0.015] dark:bg-white/[0.02] px-4 py-4" aria-hidden="true">
      <div className="flex items-center gap-2">
        <Partner side="in" count={incoming} />
        <Wire on={incoming > 0} />
        <div className="flex-1 min-w-0 flex justify-center">
          <motion.div
            layout
            className="max-w-[220px] min-w-0 rounded-xl border border-accent-lineage/40 bg-canvas-elevated shadow-sm px-3 py-2 flex items-center gap-2"
          >
            <LucideIcons.Copy className="w-3.5 h-3.5 text-accent-lineage flex-none" />
            <span className="text-[12.5px] font-semibold text-ink truncate">{name || 'The copy'}</span>
            <AnimatePresence initial={false}>
              {inside > 0 && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="px-1.5 py-0.5 rounded-md bg-accent-lineage/10 text-accent-lineage text-[10.5px] font-semibold tabular-nums flex-none"
                >
                  +{inside.toLocaleString()} inside
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
        <Wire on={outgoing > 0} />
        <Partner side="out" count={outgoing} />
      </div>
    </div>
  )
}

function Partner({ side, count }: { side: 'in' | 'out'; count: number }) {
  const on = count > 0
  return (
    <div className={cn('w-[86px] flex-none rounded-lg px-2 py-1.5 text-center transition-opacity', on ? 'opacity-100' : 'opacity-35')}>
      <div className="text-[15px] font-semibold tabular-nums text-ink leading-none">{on ? count.toLocaleString() : '–'}</div>
      <div className="mt-1 text-[10.5px] text-ink-muted">{side === 'in' ? 'feeding it' : 'it feeds'}</div>
    </div>
  )
}

function Wire({ on }: { on: boolean }) {
  return (
    <div className="relative w-10 flex-none h-px">
      <div className={cn('absolute inset-0 transition-colors', on ? 'bg-accent-lineage' : 'bg-black/15 dark:bg-white/15')} />
      <LucideIcons.ChevronRight className={cn('absolute -right-1.5 -top-[7px] w-3.5 h-3.5 transition-colors', on ? 'text-accent-lineage' : 'text-black/20 dark:text-white/20')} />
    </div>
  )
}

export default DuplicateDialog
