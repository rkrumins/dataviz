/**
 * Review & Save, for any canvas — one save path, so an edit staged on the Graph or the Hierarchy
 * canvas is kept exactly as one staged on the Context View is.
 *
 * - `useCanvasEditGate` — may this canvas change the graph: a draft of the view's own data source,
 *   edit mode on, and a draft the caller may write (someone else's, or one made private under them,
 *   opens read-only rather than taking edits its save would refuse).
 * - `useDraftSave` — what `StagedChangesPanel`'s `onConfirm` runs: the staged changes to the draft as
 *   ONE commit, and what the user is told about it. A canvas that keeps more than the graph (the
 *   Context View's layout) passes the hooks for it.
 * - `useStagedUndoShortcuts` — ⌘Z / ⇧⌘Z on the canvas, in a draft.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useAppNotifications } from '@/components/ui/notifications'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore, useEffectiveBranchId, useGraphId } from '@/store/branchStore'
import { useSaveProblemsStore } from '@/store/saveProblemsStore'
import { useActiveView } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import { useFeature } from '@/store/features'
import { canvasScopeWorkspaceId } from '@/lib/canvasScope'
import {
  BranchClosedError, DraftRoleRequiredError, IntegrityError, MergeConflictError, NotDraftOwnerError, OntologyViolationError,
  type Branch,
} from '@/services/versioningApiService'
import { VERSIONING_KEYS } from '../hooks/useVersioning'
import { useActiveDraftAccess } from '../hooks/useActiveDraftAccess'
import { saveStagedChangesToDraft } from '../model/saveStagedChangesToDraft'
import { mapSaveProblems } from '../model/saveProblems'
import { markConflicts } from '../model/mapConflicts'
import { copyStagedToNewDraft } from '../model/copyStagedToNewDraft'

export interface CanvasEditGate {
  /** The canvas-versioning scope: the view's own workspace (see canvasScopeWorkspaceId). */
  scopeWsId: string | null
  dataSourceId: string | null
  viewId: string | null
  /** The versioned graph the view reads, once resolved. */
  graphId: string | null
  /** The draft of this view open now; null on Published. */
  branchId: string | null
  /** A draft of this view is open: being on one IS edit mode. */
  isDraft: boolean
  /** Graph edits are kept here: a draft, edit mode on, and the caller may write it. */
  canEditGraph: boolean
}

/** The Context View's gate (isDraft && editModeEnabled && draftWritable), for the other canvases. */
export function useCanvasEditGate(): CanvasEditGate {
  const view = useActiveView()
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const scopeWsId = canvasScopeWorkspaceId(view?.workspaceId, activeWorkspaceId)
  const dataSourceId = view?.dataSourceId ?? null
  const viewId = view?.id ?? null
  const effectiveBranchId = useEffectiveBranchId(scopeWsId ?? '', dataSourceId, viewId)
  const isDraft = !!effectiveBranchId
  const editModeEnabled = useFeature('editModeEnabled')
  const graphId = useGraphId()
  const { canWrite: draftWritable } = useActiveDraftAccess(scopeWsId ?? undefined, graphId, viewId, effectiveBranchId)
  return {
    scopeWsId, dataSourceId, viewId, graphId, branchId: effectiveBranchId, isDraft,
    canEditGraph: isDraft && editModeEnabled && draftWritable,
  }
}

export interface DraftSaveHost {
  /** The canvas-versioning scope (`canvasScopeWorkspaceId`). Without one there is nothing to save to. */
  wsId: string | null
  viewId: string | null
  /** Re-key what the canvas holds by a new entity's temp urn to its real one, once the save made it. */
  remapEntityIds?: (ids: ReadonlyMap<string, string>) => void
  /** A save that created nothing: drop what is still keyed by a temp urn. */
  pruneTempAssignments?: () => void
  /** Persist what the canvas keeps besides the graph (the view's layout), after the graph is written. */
  flushLayoutSave?: () => Promise<void>
  /** Offered when graph edits were staged on the published graph: open a draft to save them. */
  onOpenDraft?: () => void
}

/** `prev` with each id a save re-keyed (temp → real) replaced — the same set when it holds none. */
export function remapIdSet(prev: Set<string>, ids: ReadonlyMap<string, string>): Set<string> {
  if (![...ids.keys()].some(oldId => prev.has(oldId))) return prev
  return new Set([...prev].map(id => ids.get(id) ?? id))
}

/** Review & Save's save. Resolves true once the changes are written (the panel then closes, or goes
 *  on to Publish); false leaves it open on the review, its problems shown. */
export function useDraftSave(host: DraftSaveHost): () => Promise<boolean> {
  const provider = useGraphProvider()
  const queryClient = useQueryClient()
  const { notify } = useAppNotifications()
  const applyStagedChanges = useStagedChangesStore((s) => s.applyAll)
  const { wsId: scopeWsId, viewId, remapEntityIds, pruneTempAssignments, onOpenDraft } = host
  const flushLayoutSave = host.flushLayoutSave ?? (async () => {})

  return async () => {
    if (!scopeWsId) return false
    const stagedChangeList = useStagedChangesStore.getState().changes
    // Draft mode: persist EVERY change type — creates, edges, updates/deletes, and layer
    // moves — to the draft branch as ONE atomic, server-merged /graph/changes commit. One
    // Review & Save is exactly one commit (the backend mints urns + resolves temp refs).
    const bs = useBranchStore.getState()
    if (bs.currentBranchId && bs.graphId && bs.dataSourceId) {
      try {
        const { commitId, unsaved } = await saveStagedChangesToDraft(stagedChangeList, {
          wsId: bs.workspaceId ?? scopeWsId,
          dataSourceId: bs.dataSourceId,
          branchId: bs.currentBranchId,
          provider,
          remapEntityIds,
          pruneTempAssignments,
          message: `Canvas edits (${stagedChangeList.length})`,
        })
        // Clear only what this save carried (a change staged while it ran stays); no discard
        // hooks run, so the optimistic canvas is kept.
        useStagedChangesStore.getState().clearSaved(stagedChangeList.map(c => c.id))
        // A save creates a new draft commit that every versioning surface must reflect — the
        // cumulative branch diff (Changes tab), the commit log (Commits tab), and per-entity
        // history. Invalidate the whole versioning namespace so saved changes appear at once
        // (a save is user-initiated and infrequent, so the broad refetch is fine).
        queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
        await flushLayoutSave()   // durably persist the view's referenceLayout (layers + assignments)
        // Only claim what was written. `unsaved` names node fields the op mapper cannot carry
        // (the entity drawer's schema-property inputs, a raw-JSON edit) — an edit made only of
        // those sends no ops at all, and a zero-op save resolves exactly like a commit. A green
        // "Saved to draft." over that is the lie this reports instead.
        // A zero-OP batch is not a zero-WORK batch: layer moves produce no graph ops (so no
        // commitId) and were just persisted durably by the flushLayoutSave above. Telling that
        // user nothing was saved sends them to redo work that already landed.
        const carriedSomething = !!commitId || stagedChangeList.some(
          c => c.type !== 'update_entity' && c.type !== 'rename_entity')
        if (unsaved.length > 0) {
          notify('warning', carriedSomething
            ? `Saved, except ${unsaved.join(', ')} — the app can't store ${unsaved.length === 1 ? 'that field' : 'those fields'} on an entity yet.`
            : `Nothing was saved — the app can't store ${unsaved.join(', ')} on an entity yet.`)
        } else {
          notify('success', 'Saved to draft.')
        }
        useSaveProblemsStore.getState().clear()
        // What was carried is cleared either way; the notification above says what landed.
        return true
      } catch (e) {
        if (e instanceof OntologyViolationError) {
          // Refused as a whole — nothing was written. Say exactly what and why, on the changes
          // that caused it, and keep Review & Save open on them.
          const problems = mapSaveProblems(e.violations, stagedChangeList)
          useSaveProblemsStore.getState().report(problems)
          const failing = new Map(problems.flatMap(p => p.changeIds.map(id => [id, p.reason] as const)))
          useStagedChangesStore.setState(st => ({
            changes: st.changes.map(c => (failing.has(c.id) || c.error
              ? { ...c, error: failing.get(c.id) } : c)),
          }))
          useStagedChangesStore.getState().openReviewPanel()
          notify('error', problems.length === 1
            ? `Nothing was saved. ${problems[0].reason}`
            : `Nothing was saved. ${problems.length} changes need attention.`,
            { label: 'Review', onClick: () => useStagedChangesStore.getState().openReviewPanel() })
        } else if (e instanceof MergeConflictError && Object.keys(e.current).length > 0) {
          // Refused as a whole: someone else changed fields these edits change. Put each
          // conflict on its change — with the current value — for the user to settle there.
          const n = markConflicts(e) || e.conflicts.length
          useStagedChangesStore.getState().openReviewPanel()
          notify('error', `Nothing was saved — ${n === 1 ? 'a change conflicts' : `${n} changes conflict`} with edits made since you opened ${n === 1 ? 'it' : 'them'}.`,
            { label: 'Review', onClick: () => useStagedChangesStore.getState().openReviewPanel() })
        } else if (e instanceof IntegrityError) {
          notify('error', `Nothing was saved. ${e.message}`)
        } else if (e instanceof BranchClosedError || e instanceof NotDraftOwnerError || e instanceof DraftRoleRequiredError) {
          // The draft closed under the save, is someone else's private draft, or is a shared
          // draft the user no longer edits. Keep the staged edits; they can go to a new draft.
          const fromBranchId = bs.currentBranchId
          const ownerName = e instanceof NotDraftOwnerError && e.owner
            ? queryClient.getQueriesData<Branch[]>({ queryKey: [...VERSIONING_KEYS.all, 'branches'] })
                .flatMap(([, branches]) => branches ?? [])
                .find(b => b.branchId === fromBranchId)?.userNames?.[e.owner]
            : undefined
          const why = e instanceof NotDraftOwnerError
            ? `This draft belongs to ${ownerName ?? 'someone else'} — copy your edits to a new draft.`
            : e instanceof DraftRoleRequiredError
            ? 'You’re no longer an editor of this shared draft.'
            : e.message
          notify('error', `Nothing was saved. ${why} Your changes are still here.`, {
            label: 'Copy to a new draft',
            onClick: () => {
              void copyStagedToNewDraft(fromBranchId, viewId)
                .catch(err => notify('error', (err as Error).message))
            },
          })
        } else {
          notify('error', (e as Error).message)
        }
        return false
      }
    }
    // Main mode: the view's layout changes persist with the view; graph edits never write to
    // the published graph — they stay staged, marked, for the user to take to a draft.
    const result = stagedChangeList.length > 0
      ? await applyStagedChanges(provider, scopeWsId, { graphWrites: false })
      : { ok: 0, failed: 0 }
    if (result.failed === 0) {
      await flushLayoutSave()
      return true
    } else {
      if (result.ok > 0) await flushLayoutSave()
      notify('warning', `${result.failed} ${result.failed === 1 ? 'change edits' : 'changes edit'} the published graph — open a draft to save ${result.failed === 1 ? 'it' : 'them'}.`,
        onOpenDraft ? { label: 'Open a draft', onClick: onOpenDraft } : undefined)
      return false
    }
  }
}

/** ⌘Z / ⇧⌘Z (and ⌘Y) undo and redo the canvas's staged changes — only in a draft: Published is
 *  read-only, so there is nothing staged to undo. */
export function useStagedUndoShortcuts(enabled: boolean): void {
  const undoStagedChange = useStagedChangesStore((s) => s.undo)
  const redoStagedChange = useStagedChangesStore((s) => s.redo)
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      // Ignore when the user is typing in an input/textarea
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod) return
      // Nothing is undone under a save in flight: it already carries the change.
      if (useStagedChangesStore.getState().applyStatus === 'applying') return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoStagedChange()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redoStagedChange()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, undoStagedChange, redoStagedChange])
}
