/**
 * The Import journey's state: the file, what the server read in it, what the person chose to do
 * with it, and what reconciling it against the target found.
 *
 * Held by the wizard's create resolver, above both of its phases, so going back from the
 * reconcile step to the file (or to the target) keeps everything; shared with the steps through
 * context rather than threaded through every step's props.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  inspectViewFile, reconcileViews, ViewTransferError,
  type IdentityMatch, type ImportAction, type InspectResult, type InspectedView, type ReconciledView,
  type Resolutions, type TargetSuggestion, type TransferTarget, type UpdateStrategy,
} from '@/services/viewTransferApiService'
import { getView } from '@/services/viewApiService'

/** The view an update or overwrite writes into. */
export interface ImportTargetView {
  viewId: string
  name: string
  workspaceId: string
  workspaceName?: string | null
  dataSourceId?: string | null
  dataSourceName?: string | null
  headVersion?: number | null
  canEdit?: boolean
}

export interface ImportSession {
  fileName: string | null
  fileSize: number
  inspect: InspectResult | null
  inspecting: boolean
  inspectError: { message: string; code?: string } | null
  loadFile: (file: File) => Promise<void>
  clearFile: () => void

  /** A file with several views: import them all together (the batch flow) rather than one. */
  batch: boolean
  setBatch: (batch: boolean) => void
  /** Which view of the file is being imported (a file can hold several). */
  viewIndex: number
  setViewIndex: (index: number) => void
  view: InspectedView | null
  /** Views here that already are this view (same identity), readable by the caller. */
  matches: IdentityMatch[]
  /** Data sources here this view's source most likely is, best first. */
  suggestions: TargetSuggestion[]

  action: ImportAction | null
  targetView: ImportTargetView | null
  choose: (action: ImportAction, targetView?: ImportTargetView | null) => void
  strategy: UpdateStrategy
  setStrategy: (strategy: UpdateStrategy) => void
  /** The choices the current reconcile reflects. */
  resolutions: Resolutions
  /** Choices being made, not yet re-checked. */
  draft: Resolutions
  setDraft: (draft: Resolutions) => void

  reconcile: ReconciledView | null
  reconciling: boolean
  reconcileError: string | null
  /** Reconcile against `target`, with the draft choices when `applyDraft` is set. */
  runReconcile: (target: TransferTarget, opts?: { applyDraft?: boolean }) => Promise<ReconciledView | null>
  /** Forget a reconcile that no longer matches the choices (they changed since). */
  invalidateReconcile: () => void

  /** Set when the journey was opened to update one particular view ("Update from file…"). */
  intoViewId: string | null
}

const ImportSessionContext = createContext<ImportSession | null>(null)

export const ImportSessionProvider = ImportSessionContext.Provider

/** The session, inside the Import journey; null anywhere else. */
export function useImportSession(): ImportSession | null {
  return useContext(ImportSessionContext)
}

function targetFromMatch(match: IdentityMatch): ImportTargetView {
  return {
    viewId: match.viewId, name: match.name, workspaceId: match.workspaceId,
    workspaceName: match.workspaceName, dataSourceId: match.dataSourceId ?? null,
    dataSourceName: match.dataSourceName, headVersion: match.headVersion, canEdit: match.canEdit,
  }
}

/** The action the file step starts on: update the view it already is, else create. */
function defaultChoice(
  view: InspectedView | null, inspect: InspectResult, intoViewId: string | null,
): { action: ImportAction; target: ImportTargetView | null } {
  const matches = view ? inspect.identityMatches[view.portableId] ?? [] : []
  if (intoViewId) {
    const same = matches.find(m => m.viewId === intoViewId)
    return same ? { action: 'update', target: targetFromMatch(same) } : { action: 'overwrite', target: null }
  }
  const editable = matches.find(m => m.canEdit)
  return editable ? { action: 'update', target: targetFromMatch(editable) } : { action: 'create', target: null }
}

export function useImportSessionState(opts: { file?: File | null; intoViewId?: string | null }): ImportSession {
  const intoViewId = opts.intoViewId ?? null
  // A file handed in by the opener (dropped on the Explorer) is being read from the first render.
  const [fileName, setFileName] = useState<string | null>(() => opts.file?.name ?? null)
  const [fileSize, setFileSize] = useState(() => opts.file?.size ?? 0)
  const [inspect, setInspect] = useState<InspectResult | null>(null)
  const [inspecting, setInspecting] = useState(() => !!opts.file)
  const [inspectError, setInspectError] = useState<ImportSession['inspectError']>(null)
  const [viewIndex, setViewIndexState] = useState(0)
  const [batch, setBatch] = useState(false)
  const [action, setAction] = useState<ImportAction | null>(null)
  const [targetView, setTargetView] = useState<ImportTargetView | null>(null)
  const [strategy, setStrategyState] = useState<UpdateStrategy>('replace')
  const [resolutions, setResolutions] = useState<Resolutions>({})
  const [draft, setDraft] = useState<Resolutions>({})
  const [reconcile, setReconcile] = useState<ReconciledView | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [reconcileError, setReconcileError] = useState<string | null>(null)
  // A later file (or a later reconcile) wins over an earlier one still in flight.
  const inspectSeq = useRef(0)
  const reconcileSeq = useRef(0)

  const view = inspect?.views[viewIndex] ?? null
  const matches = useMemo(() => (view && inspect ? inspect.identityMatches[view.portableId] ?? [] : []), [view, inspect])
  const suggestions = useMemo(() => (view && inspect ? inspect.targetSuggestions[view.source] ?? [] : []), [view, inspect])

  const invalidateReconcile = useCallback(() => {
    reconcileSeq.current += 1
    setReconcile(null)
    setReconcileError(null)
    setReconciling(false)
  }, [])

  const applyDefaults = useCallback(async (result: InspectResult, index: number) => {
    const choice = defaultChoice(result.views[index] ?? null, result, intoViewId)
    let target = choice.target
    if (!target && intoViewId) {
      // Overwriting the view the journey was opened on: name it, and pin its scope.
      try {
        const v = await getView(intoViewId)
        target = {
          viewId: v.id, name: v.name, workspaceId: v.workspaceId, workspaceName: v.workspaceName,
          dataSourceId: v.dataSourceId ?? null, dataSourceName: v.dataSourceName, canEdit: v.access?.canEdit,
        }
      } catch { /* the File step lets them pick another target */ }
    }
    setAction(choice.action)
    setTargetView(target)
    setStrategyState('replace')
    setResolutions({})
    setDraft({})
  }, [intoViewId])

  /** Ask the server what's in the file. State changes only once it answers, and only if no later
   *  file was loaded meanwhile. */
  const inspectFile = useCallback(async (file: File, seq: number) => {
    try {
      const result = await inspectViewFile(file)
      if (seq !== inspectSeq.current) return
      setInspect(result)
      setViewIndexState(0)
      // Several views, and not opened to update one of them: importing them all is the likely aim.
      setBatch(result.views.length > 1 && !intoViewId)
      await applyDefaults(result, 0)
    } catch (err) {
      if (seq !== inspectSeq.current) return
      setInspectError({
        message: err instanceof Error ? err.message : "This file couldn't be read.",
        code: err instanceof ViewTransferError ? err.code : undefined,
      })
    } finally {
      if (seq === inspectSeq.current) setInspecting(false)
    }
  }, [applyDefaults, intoViewId])

  const loadFile = useCallback(async (file: File) => {
    const seq = ++inspectSeq.current
    setFileName(file.name)
    setFileSize(file.size)
    setInspecting(true)
    setInspectError(null)
    setInspect(null)
    invalidateReconcile()
    await inspectFile(file, seq)
  }, [inspectFile, invalidateReconcile])

  const clearFile = useCallback(() => {
    inspectSeq.current += 1
    setFileName(null)
    setFileSize(0)
    setInspect(null)
    setInspectError(null)
    setInspecting(false)
    setAction(null)
    setTargetView(null)
    invalidateReconcile()
  }, [invalidateReconcile])

  const setViewIndex = useCallback((index: number) => {
    setViewIndexState(index)
    invalidateReconcile()
    if (inspect) void applyDefaults(inspect, index)
  }, [inspect, applyDefaults, invalidateReconcile])

  const choose = useCallback((next: ImportAction, target?: ImportTargetView | null) => {
    setAction(next)
    setTargetView(next === 'update' || next === 'overwrite' ? target ?? null : null)
    setStrategyState('replace')
    invalidateReconcile()
  }, [invalidateReconcile])

  const setStrategy = useCallback((next: UpdateStrategy) => {
    setStrategyState(next)
    invalidateReconcile()
  }, [invalidateReconcile])

  const runReconcile = useCallback(async (target: TransferTarget, opts: { applyDraft?: boolean } = {}) => {
    if (!view || !action) return null
    const seq = ++reconcileSeq.current
    const choices = opts.applyDraft ? draft : resolutions
    setReconciling(true)
    setReconcileError(null)
    try {
      const result = await reconcileViews([{
        key: String(view.index),
        portableId: view.portableId,
        definition: view.definition,
        viewType: view.metadata.viewType,
        manifest: view.manifest,
        history: view.history.map(h => h.hash),
        target,
        action,
        strategy,
        resolutions: choices,
      }])
      if (seq !== reconcileSeq.current) return null
      const reconciled = result.views[0] ?? null
      setReconcile(reconciled)
      setResolutions(choices)
      setDraft(choices)
      return reconciled
    } catch (err) {
      if (seq === reconcileSeq.current) {
        setReconcileError(err instanceof Error ? err.message : "The file couldn't be checked against this data source.")
      }
      return null
    } finally {
      if (seq === reconcileSeq.current) setReconciling(false)
    }
  }, [view, action, strategy, resolutions, draft])

  // The opener's file is read as soon as the journey opens (once: the session lives as long as
  // the open wizard).
  const initialFile = useRef(opts.file ?? null)
  useEffect(() => {
    const file = initialFile.current
    initialFile.current = null
    if (file) void inspectFile(file, ++inspectSeq.current)
  }, [inspectFile])

  return useMemo<ImportSession>(() => ({
    fileName, fileSize, inspect, inspecting, inspectError, loadFile, clearFile,
    batch, setBatch, viewIndex, setViewIndex, view, matches, suggestions,
    action, targetView, choose, strategy, setStrategy, resolutions, draft, setDraft,
    reconcile, reconciling, reconcileError, runReconcile, invalidateReconcile,
    intoViewId,
  }), [
    batch,
    fileName, fileSize, inspect, inspecting, inspectError, loadFile, clearFile,
    viewIndex, setViewIndex, view, matches, suggestions,
    action, targetView, choose, strategy, setStrategy, resolutions, draft,
    reconcile, reconciling, reconcileError, runReconcile, invalidateReconcile,
    intoViewId,
  ])
}
