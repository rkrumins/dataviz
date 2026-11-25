/**
 * hierarchyBuilderStore — central open/close state for the Hierarchy Builder panel.
 *
 * Both the React-Flow `GenericNode` (canvas node context menu) and the
 * recursive `HierarchyContainer` (Context View) need to open the builder
 * scoped to whatever node/layer the user clicked — without prop-drilling an
 * onOpen callback through every intermediate layer. This store is the shared
 * open/close surface for all three canvases.
 *
 * `open()` calls `ensureDraftOpen()` BEFORE setting state, per its doc-comment
 * contract: a draft must be active before any optimistic canvas mutation, and
 * switching branches reloads the canvas — opening a draft after the builder's
 * first stage would discard it. Centralizing the guard here means every
 * caller gets it for free instead of remembering to call it themselves. With
 * no draft (editing paused, no :manage) it does not open, so nothing is staged on main.
 *
 * Clicking an entity that is already there while adding is a look at it: the builder steps aside
 * (`suspend` — kept as it was, hidden) for that entity's details, and `resume` (Continue adding,
 * or Add inside it) brings it back where it was, or scoped to that entity.
 */
import { create } from 'zustand'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import { useCanvasStore } from '@/store/canvas'
import type { ScopeNode } from './resolveCreationScope'

export type BuilderMode = 'outline' | 'paste' | 'grid'

interface HierarchyBuilderState {
  isOpen: boolean
  /** Scope: "Adding inside X"; null = root level. */
  parentUrn: string | null
  /** ContextView layer scoping only. */
  layerId: string | null
  /** The type to start with: a palette's "Create <Type>", or the one the layer's scope prefers
   *  (see resolveCreationScope). Offered wherever the parent allows it. */
  initialTypeId: string | null
  /** The type needs a parent and none was obvious: the panel asks where it goes first. */
  askParent: boolean
  /** The parents the scope offers first ("Inside <Domain>"), one click away. */
  choices: ScopeNode[]
  /** The top-level type the scope offers as "New top-level <type>", when one is obvious. */
  topLevelTypeId: string | null
  /** The type last added inside each parent this session (urn; '' is the top level). Kept across
   *  closes, so a layer's "+" starts where the last one left off. */
  lastTypeIn: Record<string, string>
  /** 'paste' when opened from a "Paste a list" CTA. */
  initialMode: BuilderMode
  /** Type-id chain when opened from a template chip. */
  initialTemplate: string[] | null
  /** Which panel is open: the current rail, or the new Build surface. */
  surface: 'rail' | 'build'
  /**
   * Bumped on every `open()`/`openBuild()` — the session batch boundary.
   * `useHierarchyOutline` keys its scope-reset effect on this so a re-open
   * (per-layer "+", "Start another set", …) always starts a fresh batch even
   * though the panel/hook stay mounted across it (stable key).
   */
  batchId: number
  /** Temp urns staged during the CURRENT batch — cleared on every `open()`. */
  batchUrns: string[]
  /**
   * Entities staged since the drawer was last opened, across all batches —
   * reset on `close()`. Drives the "N added this session" footer line.
   */
  sessionAddedCount: number
  /** Stepped aside for an entity's details: kept as it was, hidden, until `resume`. */
  suspended: boolean
  /** Where the next entity goes once resumed (Add inside), until the panel takes it. */
  pendingRetarget: string | null
  open: (opts?: BuilderOpenOptions & { surface?: 'rail' | 'build' }) => void
  openBuild: (opts?: BuilderOpenOptions) => void
  close: () => void
  /** Step aside for an entity's details (the panel stays mounted, hidden). */
  suspend: () => void
  /** Take the rail back from the details — a drawer move, held while the drawer has edits not
   *  staged yet — adding inside `parentUrn` when given. */
  resume: (opts?: { parentUrn?: string }) => void
  /** The retarget `resume` asked for, once. */
  takeRetarget: () => string | null
  /** Registers a freshly staged temp urn into the current batch + session tally. */
  registerBatchUrn: (urn: string) => void
  /** Notes `typeId` as the last type added inside `parentUrn` (null: the top level). */
  rememberType: (parentUrn: string | null, typeId: string) => void
  /** Build: where its top-level rows go, chosen in its banner — the question, if one was asked, answered. */
  rescope: (parentUrn: string | null) => void
}

export interface BuilderOpenOptions {
  parentUrn?: string
  layerId?: string
  initialTypeId?: string
  askParent?: boolean
  choices?: ScopeNode[]
  topLevelTypeId?: string
  mode?: BuilderMode
  template?: string[]
}

export const useHierarchyBuilderStore = create<HierarchyBuilderState>((set, get) => ({
  isOpen: false,
  parentUrn: null,
  layerId: null,
  initialTypeId: null,
  askParent: false,
  choices: [],
  topLevelTypeId: null,
  lastTypeIn: {},
  initialMode: 'outline',
  initialTemplate: null,
  surface: 'rail',
  batchId: 0,
  batchUrns: [],
  sessionAddedCount: 0,
  suspended: false,
  pendingRetarget: null,

  // The builder takes the right rail from the drawer — a drawer move, held while the drawer has
  // edits not staged yet.
  open: (opts) => useCanvasStore.getState().requestDrawerMove(() => {
    void ensureDraftOpen().then((draftId) => {
      if (!draftId) return
      set((s) => ({
        isOpen: true,
        parentUrn: opts?.parentUrn ?? null,
        layerId: opts?.layerId ?? null,
        initialTypeId: opts?.initialTypeId ?? null,
        askParent: opts?.askParent ?? false,
        choices: opts?.choices ?? [],
        topLevelTypeId: opts?.topLevelTypeId ?? null,
        initialMode: opts?.mode ?? 'outline',
        initialTemplate: opts?.template ?? null,
        surface: opts?.surface ?? 'rail',
        batchId: s.batchId + 1,
        batchUrns: [],
        suspended: false,
        pendingRetarget: null,
      }))
    })
  }),

  openBuild: (opts) => get().open({ ...opts, surface: 'build' }),

  close: () =>
    set({
      isOpen: false,
      parentUrn: null,
      layerId: null,
      initialTypeId: null,
      askParent: false,
      choices: [],
      topLevelTypeId: null,
      initialMode: 'outline',
      initialTemplate: null,
      surface: 'rail',
      sessionAddedCount: 0,
      suspended: false,
      pendingRetarget: null,
    }),

  suspend: () => set({ suspended: true }),

  resume: (opts) => useCanvasStore.getState().requestDrawerMove(() => {
    set({ suspended: false, pendingRetarget: opts?.parentUrn ?? null })
  }),

  takeRetarget: () => {
    const to = get().pendingRetarget
    if (to) set({ pendingRetarget: null })
    return to
  },

  registerBatchUrn: (urn) =>
    set((s) => ({ batchUrns: [...s.batchUrns, urn], sessionAddedCount: s.sessionAddedCount + 1 })),

  rememberType: (parentUrn, typeId) => set((s) => (s.lastTypeIn[parentUrn ?? ''] === typeId
    ? s : { lastTypeIn: { ...s.lastTypeIn, [parentUrn ?? '']: typeId } })),

  rescope: (parentUrn) => set({ parentUrn, askParent: false }),
}))
