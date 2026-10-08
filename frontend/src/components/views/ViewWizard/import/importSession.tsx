/**
 * The Import journey's state: the file, what the server read in it, what the person chose to do
 * with it, and what reconciling it against the target found. For a view with its data (a
 * package), also the data's way into a draft of the target, which the view then follows.
 *
 * Held by the wizard's create resolver, above both of its phases, so going back from the
 * reconcile step to the file (or to the target) keeps everything; shared with the steps through
 * context rather than threaded through every step's props.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  getPackageUpload, getViewPackage, importPackageData, inspectViewFile, inspectViewPackage, isViewPackage,
  reconcileViews, ViewTransferError,
  type IdentityMatch, type ImportAction, type InspectResult, type InspectedView, type PackageDataStarted,
  type PackageInspectResult, type PackageProgress, type ReconciledView, type Resolutions, type TargetSuggestion,
  type TransferTarget, type UpdateStrategy,
} from '@/services/viewTransferApiService'
import { getImport, getImportPreview, pollJob, type ImportPreview, type Job } from '@/services/importExportApiService'
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

/** Where a package's data goes: into a new draft of a data source here (and the view the package
 *  will update, if any: the draft is then that view's), or into a brand-new data source of its
 *  own, an independent full copy on the connection chosen, under the label and graph name given. */
export type PackageDataTarget =
  | {
    kind: 'existing'
    workspaceId: string
    dataSourceId: string
    viewId?: string | null
    /** What the new draft is called (the server names it after the package's view otherwise). */
    draftName?: string | null
  }
  | {
    kind: 'new'
    workspaceId: string
    providerId: string
    label: string
    graphName: string
    /** Its semantic layer (a draft one too); null for none. */
    ontologyId: string | null
  }

export type ExistingDataTarget = Extract<PackageDataTarget, { kind: 'existing' }>
export type NewDataTarget = Extract<PackageDataTarget, { kind: 'new' }>

/** A package's data on its way into a draft of the target. */
export interface PackageData {
  /** Where it was asked into. */
  target: PackageDataTarget | null
  /** The draft and the import job, once the server has started it. */
  started: PackageDataStarted | null
  job: Job | null
  /** What the job did, once it has finished. */
  preview: ImportPreview | null
  running: boolean
  error: string | null
  /** The package's upload expired (or is about to): its data comes in only from the file chosen
   *  again. */
  expired: boolean
}

const NO_DATA: PackageData = {
  target: null, started: null, job: null, preview: null, running: false, error: null, expired: false,
}

export function sameDataTarget(a: PackageDataTarget | null, b: PackageDataTarget | null): boolean {
  if (!a || !b || a.workspaceId !== b.workspaceId) return false
  if (a.kind === 'existing' && b.kind === 'existing') {
    return a.dataSourceId === b.dataSourceId && (a.viewId ?? null) === (b.viewId ?? null)
  }
  if (a.kind === 'new' && b.kind === 'new') {
    return a.providerId === b.providerId && a.label === b.label && a.graphName === b.graphName
      && a.ontologyId === b.ontologyId
  }
  return false
}

export interface ImportSession {
  fileName: string | null
  fileSize: number
  /** The file as this browser knows it (name, size, modification time), or the upload it was read
   *  from: what is remembered for it, across a reload, is kept under this. */
  fileKey: string | null
  inspect: InspectResult | null
  inspecting: boolean
  /** While a package is read: how much of it is up, then how far its check has got. */
  inspectProgress: PackageProgress | null
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

  /** The file is a view with its data (a package), kept on the server until its data comes in. */
  pkg: { uploadId: string; info: PackageInspectResult['package'] } | null
  /** A package's data comes with its view (the default). Without it, the package imports as a
   *  view file would. False for any other file. */
  withData: boolean
  setWithData: (withData: boolean) => void
  data: PackageData
  /** Bring the package's data into a new draft of `target`. Each target gets a draft of its own
   *  (asking again for one answers with its job), until the upload expires. (A new data source is
   *  created and followed by the Data step itself: NewSourceSeedStep.) */
  startData: (target: ExistingDataTarget) => Promise<void>
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

const fileKeyOf = (file: File) => `${file.name}:${file.size}:${file.lastModified}`

export function useImportSessionState(opts: {
  file?: File | null
  intoViewId?: string | null
  /** A package already uploaded, read again from there (no file): "Finish importing views". */
  uploadId?: string | null
}): ImportSession {
  const intoViewId = opts.intoViewId ?? null
  // A file handed in by the opener (dropped on the Explorer) is being read from the first render.
  const [fileName, setFileName] = useState<string | null>(() => opts.file?.name ?? null)
  const [fileSize, setFileSize] = useState(() => opts.file?.size ?? 0)
  const [fileKey, setFileKey] = useState<string | null>(() => (opts.file ? fileKeyOf(opts.file)
    : opts.uploadId ? `upload:${opts.uploadId}` : null))
  const [inspect, setInspect] = useState<InspectResult | null>(null)
  const [inspecting, setInspecting] = useState(() => !!opts.file || !!opts.uploadId)
  const [inspectProgress, setInspectProgress] = useState<PackageProgress | null>(null)
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
  const [pkg, setPkg] = useState<ImportSession['pkg']>(null)
  const [dataChoice, setDataChoice] = useState(true)
  const [data, setData] = useState<PackageData>(NO_DATA)
  // A later file (or a later reconcile) wins over an earlier one still in flight.
  const inspectSeq = useRef(0)
  const reconcileSeq = useRef(0)
  // A package's upload and check being followed, stopped when the file changes or the journey
  // closes: choosing the same file again resumes the upload.
  const inspectRun = useRef<AbortController | null>(null)
  // The opener's file (dropped on the Explorer), until another is chosen.
  const initialFile = useRef(opts.file ?? null)
  // Or the opener's upload, read again from the server.
  const initialUpload = useRef(opts.file ? null : opts.uploadId ?? null)
  // The data import being followed, stopped when the file changes or the journey closes.
  const dataRun = useRef<AbortController | null>(null)
  const withData = pkg !== null && dataChoice

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

  /** What the server read in a file becomes the session's. */
  const adopt = useCallback(async (result: InspectResult, packaged: boolean) => {
    setInspect(result)
    setPkg(packaged ? { uploadId: (result as PackageInspectResult).uploadId, info: (result as PackageInspectResult).package } : null)
    setDataChoice(true)
    setViewIndexState(0)
    // Several views, and not opened to update one of them: importing them all is the likely aim.
    // A package's data goes into one draft with one view, so it brings one of its views.
    setBatch(!packaged && result.views.length > 1 && !intoViewId)
    await applyDefaults(result, 0)
  }, [applyDefaults, intoViewId])

  /** Ask the server what's in the file. State changes only once it answers, and only if no later
   *  file was loaded meanwhile. */
  const inspectFile = useCallback(async (file: File, seq: number) => {
    inspectRun.current?.abort()
    const run = new AbortController()
    inspectRun.current = run
    try {
      const packaged = await isViewPackage(file)
      if (run.signal.aborted) return                // another file, or the journey closed
      const result: InspectResult = packaged
        ? await inspectViewPackage(file, {
          signal: run.signal,
          onProgress: (progress) => { if (seq === inspectSeq.current) setInspectProgress(progress) },
        })
        : await inspectViewFile(file)
      if (seq !== inspectSeq.current) return
      await adopt(result, packaged)
    } catch (err) {
      if (seq !== inspectSeq.current) return
      setInspectError({
        message: err instanceof Error ? err.message : "This file couldn't be read.",
        code: err instanceof ViewTransferError ? err.code : undefined,
      })
    } finally {
      if (seq === inspectSeq.current) {
        setInspecting(false)
        setInspectProgress(null)
      }
    }
  }, [adopt])

  /** A package already uploaded and checked, read again from its upload: nothing is sent. */
  const inspectUpload = useCallback(async (uploadId: string, seq: number) => {
    try {
      const [upload, result] = await Promise.all([getPackageUpload(uploadId), getViewPackage(uploadId)])
      if (seq !== inspectSeq.current) return
      setFileName(upload.fileName)
      setFileSize(upload.size)
      await adopt(result, true)
    } catch (err) {
      if (seq !== inspectSeq.current) return
      setInspectError({
        message: err instanceof Error ? err.message : "The package couldn't be read.",
        code: err instanceof ViewTransferError ? err.code : undefined,
      })
    } finally {
      if (seq === inspectSeq.current) setInspecting(false)
    }
  }, [adopt])

  const forgetData = useCallback(() => {
    dataRun.current?.abort()
    dataRun.current = null
    setPkg(null)
    setData(NO_DATA)
  }, [])

  const loadFile = useCallback(async (file: File) => {
    initialFile.current = null
    initialUpload.current = null
    const seq = ++inspectSeq.current
    setFileName(file.name)
    setFileSize(file.size)
    setFileKey(fileKeyOf(file))
    setInspecting(true)
    setInspectProgress(null)
    setInspectError(null)
    setInspect(null)
    forgetData()
    invalidateReconcile()
    await inspectFile(file, seq)
  }, [inspectFile, invalidateReconcile, forgetData])

  const clearFile = useCallback(() => {
    initialFile.current = null
    initialUpload.current = null
    inspectSeq.current += 1
    inspectRun.current?.abort()
    setFileName(null)
    setFileSize(0)
    setFileKey(null)
    setInspect(null)
    setInspectError(null)
    setInspecting(false)
    setInspectProgress(null)
    setAction(null)
    setTargetView(null)
    forgetData()
    invalidateReconcile()
  }, [invalidateReconcile, forgetData])

  const setWithData = useCallback((next: boolean) => {
    setDataChoice(next)
    // Without the data, a package of several views imports like a file of several views.
    setBatch(!next && (inspect?.views.length ?? 0) > 1 && !intoViewId)
    // Checked against the data's draft, or not: a reconcile answers for one of the two.
    invalidateReconcile()
  }, [inspect, intoViewId, invalidateReconcile])

  const startData = useCallback(async (target: ExistingDataTarget) => {
    if (!pkg) return
    dataRun.current?.abort()
    const run = new AbortController()
    dataRun.current = run
    setData({ ...NO_DATA, target, running: true })
    try {
      const { workspaceId, dataSourceId, viewId, draftName } = target
      const started = await importPackageData(pkg.uploadId, { workspaceId, dataSourceId, viewId, draftName })
      if (run.signal.aborted) return
      setData(d => ({ ...d, started }))
      const job = await pollJob(() => getImport(started.workspaceId, started.graphId, started.jobId), {
        signal: run.signal,
        onTick: (tick) => { if (!run.signal.aborted) setData(d => ({ ...d, job: tick })) },
      })
      if (job.status !== 'completed') throw new Error(job.errorMessage || "The data couldn't be imported.")
      const preview = await getImportPreview(started.workspaceId, started.graphId, started.jobId)
      if (run.signal.aborted) return
      setData(d => ({ ...d, job, preview, running: false }))
    } catch (err) {
      if (run.signal.aborted) return
      // 410 `upload_expired`: the upload is gone, or about to be. Not any 404 — that is also a
      // missing workspace or view, which choosing the file again would not fix.
      const expired = err instanceof ViewTransferError && (err.status === 410 || err.type === 'upload_expired')
      setData(d => ({
        ...d, running: false, expired, error: err instanceof Error ? err.message : "The data couldn't be imported.",
      }))
    }
  }, [pkg])

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

  // The opener's file is read as soon as the journey opens (the session lives as long as the
  // open wizard). Closing the journey stops a package's upload: the same file chosen again resumes
  // it. So does StrictMode's remount, whose read of the opener's file starts again.
  useEffect(() => {
    const file = initialFile.current
    if (file) void inspectFile(file, ++inspectSeq.current)
    else if (initialUpload.current) void inspectUpload(initialUpload.current, ++inspectSeq.current)
    return () => inspectRun.current?.abort()
  }, [inspectFile, inspectUpload])

  // Closing the journey stops following a data import (the import itself carries on).
  useEffect(() => () => dataRun.current?.abort(), [])

  return useMemo<ImportSession>(() => ({
    fileName, fileSize, fileKey, inspect, inspecting, inspectProgress, inspectError, loadFile, clearFile,
    batch, setBatch, viewIndex, setViewIndex, view, matches, suggestions,
    action, targetView, choose, strategy, setStrategy, resolutions, draft, setDraft,
    reconcile, reconciling, reconcileError, runReconcile, invalidateReconcile,
    intoViewId,
    pkg, withData, setWithData, data, startData,
  }), [
    batch,
    fileName, fileSize, fileKey, inspect, inspecting, inspectProgress, inspectError, loadFile, clearFile,
    viewIndex, setViewIndex, view, matches, suggestions,
    action, targetView, choose, strategy, setStrategy, resolutions, draft,
    reconcile, reconciling, reconcileError, runReconcile, invalidateReconcile,
    intoViewId,
    pkg, withData, setWithData, data, startData,
  ])
}
