/**
 * CanvasVersioningBar — the single top strip that carries all versioning chrome for
 * every canvas. Mounted once in CanvasRouter (above the canvas), so it never fights
 * the canvases' own floating toolbars. Renders nothing when the data source has no
 * versioned graph, so non-versioned views are untouched.
 *
 * On a draft: an amber strip with the committed change counts (+ unsaved-edit hint),
 * and Review / Publish / Discard.
 *
 * On main it renders NOTHING, most of the time — and that is the point. It used to
 * hold the branch switcher on the left and Reviews on the right and nothing else: a
 * whole band of chrome for two controls, stacked under a page header that named the
 * view and above a canvas toolbar that named it again. Reviews moved up into the page
 * header (ViewReviewsButton) and the switcher moved down into the Context View's
 * toolbar, which had a title slot going spare. What is left here on main is two
 * TRANSIENT chips — projection sync and rollup sync — so the row
 * is `empty:hidden`: when every child renders null there is no bar, no border and no
 * padding, and the canvas takes the space back.
 *
 * `showBranchSwitcher` is false only for the canvas that hosts the switcher itself
 * (the Context View). Every other canvas has no toolbar slot for it and keeps it here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, GitPullRequest, Trash2, Loader2, GitBranch, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { usePermission } from '@/store/auth'
import { useActiveView } from '@/store/schema'
import { useBranchStore, useEffectiveBranchId } from '@/store/branchStore'
import { useStagedChangeCount } from '@/store/stagedChangesStore'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { useAbandonDraft, useBranchFreshness, useBranches, useDiffVsMain, useResolveGraph } from '../hooks/useVersioning'
import { useActiveBranchGuard, type BranchEviction } from '../hooks/useActiveBranchGuard'
import { fromDiffVsMain } from '../model/changeAdapters'
import { EMPTY_CHANGE_SET } from '../model/changeModel'
import { useBootstrapWatch } from '../model/useBootstrapWatch'
import { BRANCH_VOCAB } from '../model/branchVocab'
import { AggregationSyncChip } from './AggregationSyncChip'
import { BootstrapProgress } from './BootstrapProgress'
import { EnableVersioningFlow } from './EnableVersioningFlow'
import { BranchSwitcher } from './BranchSwitcher'
import { PullBeforeMergeBanner } from './PullBeforeMergeBanner'
import { RefreshingBadge } from './RefreshingBadge'
import { ChangeCountChips } from './ChangesPanel'
import { CommitDialog } from './CommitDialog'
import { PublishReceiptBanner } from './PublishReceiptBanner'
import { ViewVersioningPanel, type ViewPanelTab } from './ViewVersioningPanel'

interface CanvasVersioningBarProps {
  workspaceId: string
  dataSourceId: string | null
  /** False when the host canvas renders the BranchSwitcher in its own toolbar
   *  (the Context View does). Every other canvas keeps it here. */
  showBranchSwitcher?: boolean
}

export function CanvasVersioningBar({
  workspaceId,
  dataSourceId,
  showBranchSwitcher = true,
}: CanvasVersioningBarProps) {
  const { notify } = useAppNotifications()
  const canManage = usePermission('workspace:datasource:manage', workspaceId)
  // Hoisted so the resolve below can carry the view id (capability context +
  // shared cache entry with the canvas's own resolve).
  const activeView = useActiveView()
  const resolve = useResolveGraph(workspaceId, dataSourceId, activeView?.id ?? null)
  const graphId = resolve.data?.graphId ?? null
  const [showEnable, setShowEnable] = useState(false)
  // The enablement job: live progress while it runs (seeded from /resolve, so a reload
  // lands straight back on it), then the integrity report until it's dismissed.
  const boot = useBootstrapWatch(workspaceId, dataSourceId, {
    headSeq: resolve.data?.mainHeadCommitSeq ?? 0,
    seed: resolve.data?.bootstrap ?? undefined,
  })

  const viewId = activeView?.id ?? null
  const viewName = activeView?.name ?? null
  // Branch-per-view: scope the effective branch to the active view, so `isDraft` never reflects
  // another view's draft on the same data source.
  const branchId = useEffectiveBranchId(workspaceId, dataSourceId, viewId)
  const isDraft = !!branchId
  const committedDiffHidden = useBranchStore((s) => s.committedDiffHidden)
  const setCommittedDiffHidden = useBranchStore((s) => s.setCommittedDiffHidden)
  const setActiveChangeSet = useBranchStore((s) => s.setActiveChangeSet)
  const switchToMain = useBranchStore((s) => s.switchToMain)

  const [showPublish, setShowPublish] = useState(false)
  const [panelTab, setPanelTab] = useState<ViewPanelTab | null>(null)
  const uncommitted = useStagedChangeCount()

  const diffQ = useDiffVsMain(workspaceId, graphId, isDraft ? branchId : null)
  const changeSet = useMemo(
    () => (diffQ.data && branchId ? fromDiffVsMain(diffQ.data, branchId) : EMPTY_CHANGE_SET),
    [diffQ.data, branchId],
  )
  useEffect(() => {
    if (isDraft) setActiveChangeSet(changeSet)
  }, [isDraft, changeSet, setActiveChangeSet])

  // One-shot bridge: the Context View header's "Changes" button (far from this bar)
  // asks to open the versioning panel via useVersioningPanelStore. Honour the request
  // by opening the panel on the requested tab, then clear it. Ignored when there's no
  // graph yet (the panel needs graphId) — harmless, since the header button only shows
  // in a draft, where a graph necessarily exists.
  const requestedTab = useVersioningPanelStore((s) => s.requestedTab)
  const clearPanelRequest = useVersioningPanelStore((s) => s.clearRequest)
  useEffect(() => {
    if (!requestedTab) return
    if (graphId) setPanelTab(requestedTab)
    clearPanelRequest()
  }, [requestedTab, graphId, clearPanelRequest])

  const abandon = useAbandonDraft(workspaceId, graphId ?? '')

  // Is the active draft behind main? Drives the toolbar "Pull latest" — derived locally (like the switcher).
  // View-scoped, matching BranchSwitcher's key EXACTLY. It used to fetch the graph-wide list (no
  // viewId) while the switcher fetched the view-scoped one — two cache entries and two requests for
  // the same data, with `behindMain` derived from the wrong (graph-wide) one.
  const branchesQ = useBranches(workspaceId, viewId ? graphId : null, viewId)
  const mainHead = resolve.data?.mainHeadCommitSeq ?? 0

  // "Is this draft behind Published?" from the O(1) freshness endpoint, which POLLS — so a teammate
  // publishing under you shows up promptly instead of whenever the bar happens to re-render. This
  // is the signal the (now deleted) BranchBehindBanner existed to provide; folding it in here is
  // what let the two contradictory banners become one.
  const freshness = useBranchFreshness(workspaceId, graphId, isDraft ? branchId : null)
  const behindMain = freshness.data?.behind === true

  // A draft can die under you — you published it, its review was merged (possibly from the Reviews
  // inbox, with no canvas mounted), a teammate merged the shared draft, someone discarded it. The
  // server marks the branch merged/abandoned; without this the client kept editing that dead scope.
  // Deriving liveness from the branches list self-heals every one of those paths at once.
  const onBranchEvicted = useCallback(
    ({ status, hadUnsavedEdits }: BranchEviction) => {
      const merged = status === 'merged'
      if (hadUnsavedEdits) {
        // Never silently drop the optimistic canvas — the edits are still in the staged store and
        // can be re-saved onto a fresh draft, but the user has to know they didn't land.
        notify(
          'warning',
          merged
            ? 'This draft was published while you had unsaved edits — they were not included. You’re now on Published; start a new draft to save them.'
            : 'This draft was discarded while you had unsaved edits — they were not saved. You’re now on Published.',
        )
        return
      }
      notify('info', merged
        ? 'This draft has been published — you’re now on the Published version.'
        : 'This draft is no longer available — you’re now on the Published version.')
    },
    [notify],
  )
  useActiveBranchGuard({
    enabled: !!graphId,
    branches: branchesQ.data,
    listRefreshing: branchesQ.isFetching,
    currentBranchId: branchId,
    unsavedCount: uncommitted,
    onEvict: onBranchEvicted,
  })

  // No data source, or still resolving → render nothing (avoid flicker).
  if (!dataSourceId || (resolve.isLoading && !graphId)) return null

  // The copy just landed: hold the strip on the INTEGRITY REPORT until the user is done
  // with it. Without this the graph turns versioned in the same frame and the receipt —
  // the whole reason enabling is no longer an act of faith — would flash past unread.
  if (boot.showReport && boot.job) {
    return (
      <BootstrapProgress
        job={boot.job}
        wsId={workspaceId}
        dataSourceId={dataSourceId}
        variant="bar"
        canManage={canManage}
        onDismiss={boot.dismissReport}
      />
    )
  }

  // No versioned graph yet — or one that exists but was never seeded (genesis only,
  // mainHeadCommitSeq <= 1; e.g. a bootstrap that failed partway). Offer to enable/seed
  // it (managers only). This premium empty state is what makes the feature discoverable
  // AND self-heals a half-enabled graph. A `kind === 'blank'` model is EXCLUDED: it is
  // genesis-only by design (built by hand, never seeded from a provider), so it gets
  // the normal versioning strip + the canvas's guided empty state instead.
  const isBlankModel = resolve.data?.kind === 'blank'
  const needsSeed = !graphId || (!isBlankModel && (resolve.data?.mainHeadCommitSeq ?? 0) <= 1)
  if (needsSeed) {
    if (!canManage) return null
    // A copy in flight (or one that stopped) OWNS this strip: the user watches it, and
    // a reload comes straight back to it (the job is seeded from /resolve).
    if (boot.showProgress && boot.job) {
      return (
        <BootstrapProgress
          job={boot.job}
          wsId={workspaceId}
          dataSourceId={dataSourceId}
          variant="bar"
          canManage={canManage}
        />
      )
    }
    return (
      <>
        {/* `via-canvas-elevated/40` emitted nothing, which left the gradient
            with no middle stop; the accent wash is a real palette colour and
            paints, so the band keeps it and drops the phantom. */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-glass-border bg-gradient-to-r from-accent-lineage/[0.07] to-transparent shrink-0">
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-accent-lineage/10 border border-accent-lineage/20 shrink-0">
            <GitBranch className="w-4 h-4 text-accent-lineage" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink leading-tight">Version control is off for this data source</p>
            <p className="text-[11px] text-ink-muted leading-tight">
              Turn it on to edit safely in drafts, review changes, and publish with full history.
            </p>
          </div>
          <div className="flex-1" />
          <button
            onClick={() => setShowEnable(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Enable version control
          </button>
        </div>
        <EnableVersioningFlow
          open={showEnable}
          onClose={() => setShowEnable(false)}
          wsId={workspaceId}
          dataSourceId={dataSourceId}
        />
      </>
    )
  }

  const handleDiscard = () => {
    if (!branchId) return
    if (!window.confirm('Discard this draft? All its changes will be abandoned.')) return
    abandon.mutate(branchId, {
      onSuccess: () => {
        switchToMain()
        notify('success', 'Draft discarded.')
      },
      onError: (e) => notify('error', (e as Error).message),
    })
  }

  return (
    <>
      {/* "Your changes are now live" — sits ABOVE the controls: it announces what happened, it isn't
          something to operate. Survives the navigation back from the Reviews inbox. */}
      <PublishReceiptBanner graphId={graphId} onViewCommit={() => setPanelTab('history')} />
      <div
        className={cn(
          // empty:hidden is what collapses the band. On main every child below is
          // conditional or self-hiding, so when none of them has anything to say the
          // row has no child NODES at all, `:empty` matches, and the border and
          // padding go with it — CanvasRouter's flex-1 canvas takes the height back.
          // A draft always renders its change-count block, so it is never empty.
          'empty:hidden flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 border-b text-sm shrink-0 min-w-0',
          // `bg-canvas-elevated/40` painted nothing at all — the published
          // band was transparent over the canvas. A real neutral gives it the
          // quiet lift it was always asking for.
          isDraft
            ? 'bg-amber-500/10 border-amber-500/20'
            : 'bg-black/[0.025] dark:bg-white/[0.025] border-glass-border',
        )}
      >
        {showBranchSwitcher && <BranchSwitcher workspaceId={workspaceId} dataSourceId={dataSourceId} />}
        <RefreshingBadge workspaceId={workspaceId} graphId={graphId} />
        {/* Publish → rollup visibility for hand-built models: when the published head
            advances, poll aggregation readiness and show Syncing → Synced. */}
        <AggregationSyncChip dataSourceId={dataSourceId} mainHeadSeq={mainHead} enabled={isBlankModel} />

        {isDraft && branchId && (
          <div className="flex items-center gap-2 text-ink-muted">
            {diffQ.isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <>
                {/* The distinction the whole draft model hinges on — saved to
                    the draft vs. not saved at all — was spelled out in OS
                    chrome after a one-second wait. */}
                {changeSet.changes.length > 0 ? (
                  <HoverTip
                    className="inline-flex"
                    label={`Saved to this ${BRANCH_VOCAB.draft.toLowerCase()}, not published yet`}
                    detail={`${BRANCH_VOCAB.publish} sends them to the version everyone sees`}
                  >
                    <span className="flex items-center gap-1.5">
                      <ChangeCountChips changeSet={changeSet} />
                      <span className="text-[11px] text-ink-muted/80">in branch</span>
                    </span>
                  </HoverTip>
                ) : uncommitted === 0 ? (
                  <span className="text-xs">No changes yet</span>
                ) : null}
                {uncommitted > 0 && (
                  <HoverTip
                    className="inline-flex"
                    label="Edited on the canvas, not saved to the draft yet"
                    detail="Review &amp; Save writes them into the draft"
                  >
                    <span className="text-xs font-medium text-amber-500 inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> {uncommitted} unsaved
                    </span>
                  </HoverTip>
                )}
              </>
            )}
          </div>
        )}

        {/* Draft-only spacer. On main it would be a child of its own, and the row
            could never be empty — the one thing standing between this bar and the
            band it gives back. `ml-auto` below keeps the review chip right-aligned
            in both states instead. */}
        {isDraft && branchId && <div className="flex-1" />}

        {/* The review SIGNAL followed the Reviews BUTTON up into the page
            header, and for the same reason the button went: it is the one
            thing here that is NOT transient. The other two chips appear while
            a projection or a rollup catches up and then go; one open review
            held this whole band for as long as it stood open, above a toolbar,
            which read as a dead strip. It now sits under the actions it points
            at, and this row is empty again on main. */}

        {isDraft && branchId && (
          <>
            <ChangeHighlightControl
              committedHidden={committedDiffHidden}
              onToggle={() => setCommittedDiffHidden(!committedDiffHidden)}
              hasCommitted={changeSet.changes.length > 0}
            />

            {/* The most consequential control in the bar, and the only one in
                its cluster that said nothing on hover. */}
            <HoverTip
              className="inline-flex"
              label={`Send this draft to the ${BRANCH_VOCAB.published.toLowerCase()} version everyone sees`}
              detail="Shows you what would change before anything happens"
            >
              <button
                onClick={() => setShowPublish(true)}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm transition-all"
              >
                <GitPullRequest className="w-3.5 h-3.5" />
                Publish
              </button>
            </HoverTip>

            {/* Destructive AND icon-only, so the `title` was also its only
                accessible name — the conversion has to hand that back. */}
            <HoverTip
              className="inline-flex"
              label="Throw this draft away"
              detail="Everything in it goes, and it cannot be brought back"
            >
              <button
                onClick={handleDiscard}
                disabled={abandon.isPending}
                aria-label="Discard draft"
                className="p-1.5 rounded-lg text-ink-muted hover:text-rose-500 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
              >
                {abandon.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              </button>
            </HoverTip>
          </>
        )}
      </div>

      {isDraft && branchId && graphId && behindMain && (
        <PullBeforeMergeBanner
          wsId={workspaceId}
          graphId={graphId}
          branchId={branchId}
          baseCommitSeq={freshness.data?.baseCommitSeq ?? 0}
          mainHead={freshness.data?.mainHeadCommitSeq ?? mainHead}
        />
      )}

      {showPublish && branchId && (
        <CommitDialog
          workspaceId={workspaceId}
          graphId={graphId}
          branchId={branchId}
          changeSet={changeSet}
          onClose={() => setShowPublish(false)}
        />
      )}

      {panelTab && graphId && (
        <ViewVersioningPanel
          wsId={workspaceId}
          graphId={graphId}
          viewId={viewId}
          dataSourceId={dataSourceId}
          branchId={isDraft ? branchId : null}
          viewName={viewName}
          initialTab={panelTab}
          canManage={canManage}
          onClose={() => setPanelTab(null)}
        />
      )}
    </>
  )
}

/** Committed-vs-main highlight toggle, and the legend for what the canvas draws.
 *
 *  This control used to fire TWO tooltips at once: a native `title` on the
 *  button and, simultaneously and with no delay, a hand-rolled `group-hover`
 *  panel — the app's only bespoke hover card, clipped by its ancestors and
 *  layered under the real tooltip layer. Both are one `HoverTip` now: the
 *  action leads, the legend is the body. `label` takes a node precisely so a
 *  legend like this does not need a second component. */
function ChangeHighlightControl({
  committedHidden,
  onToggle,
  hasCommitted,
}: {
  committedHidden: boolean
  onToggle: () => void
  hasCommitted: boolean
}) {
  return (
    <HoverTip
      className="inline-flex"
      label={(
        <span className="block">
          <span className="block text-[12px] font-semibold leading-snug text-ink">
            {committedHidden ? 'Show saved changes on the canvas' : 'Hide saved changes on the canvas'}
          </span>
          <span className="mt-2 block space-y-1.5 text-[11px] leading-snug text-ink-muted">
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 rounded ring-2 ring-emerald-500/70 inline-block shrink-0" />
              solid ring = saved to this draft
            </span>
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 rounded outline-dashed outline-2 outline-offset-1 outline-emerald-400/80 inline-block shrink-0" />
              dashed halo = edited but not saved
            </span>
            <span className="flex items-center gap-3 border-t border-glass-border/60 pt-1.5">
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />new</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" />edited</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" />deleted</span>
            </span>
          </span>
        </span>
      )}
    >
      <button
        onClick={onToggle}
        disabled={!hasCommitted}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-40',
          !committedHidden && hasCommitted ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay',
        )}
      >
        {committedHidden && hasCommitted ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        Committed
      </button>
    </HoverTip>
  )
}
