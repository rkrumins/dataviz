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
 * caller gets it for free instead of remembering to call it themselves.
 */
import { create } from 'zustand'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'

export type BuilderMode = 'outline' | 'paste' | 'grid'

interface HierarchyBuilderState {
  isOpen: boolean
  /** Scope: "Adding inside X"; null = root level. */
  parentUrn: string | null
  /** ContextView layer scoping only. */
  layerId: string | null
  /** CommandPalette "Create <Type>". */
  initialTypeId: string | null
  /** 'paste' when opened from a "Paste a list" CTA. */
  initialMode: BuilderMode
  /** Type-id chain when opened from a template chip. */
  initialTemplate: string[] | null
  /** Which panel is open: the current rail, or the new Build surface. */
  surface: 'rail' | 'build'
  open: (opts?: {
    parentUrn?: string
    layerId?: string
    initialTypeId?: string
    mode?: BuilderMode
    template?: string[]
    surface?: 'rail' | 'build'
  }) => void
  openBuild: (opts?: {
    parentUrn?: string
    layerId?: string
    initialTypeId?: string
    mode?: BuilderMode
    template?: string[]
  }) => void
  close: () => void
}

export const useHierarchyBuilderStore = create<HierarchyBuilderState>((set, get) => ({
  isOpen: false,
  parentUrn: null,
  layerId: null,
  initialTypeId: null,
  initialMode: 'outline',
  initialTemplate: null,
  surface: 'rail',

  open: (opts) => {
    void ensureDraftOpen()
    set({
      isOpen: true,
      parentUrn: opts?.parentUrn ?? null,
      layerId: opts?.layerId ?? null,
      initialTypeId: opts?.initialTypeId ?? null,
      initialMode: opts?.mode ?? 'outline',
      initialTemplate: opts?.template ?? null,
      surface: opts?.surface ?? 'rail',
    })
  },

  openBuild: (opts) => get().open({ ...opts, surface: 'build' }),

  close: () =>
    set({
      isOpen: false,
      parentUrn: null,
      layerId: null,
      initialTypeId: null,
      initialMode: 'outline',
      initialTemplate: null,
      surface: 'rail',
    }),
}))
