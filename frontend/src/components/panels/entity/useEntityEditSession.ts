/**
 * useEntityEditSession — the entity drawer's edit: its working copy of the node, whether it holds
 * anything not staged yet, and staging or throwing it away.
 *
 * - The copy is taken when the entity shown changes, and — while nothing is being edited — it
 *   follows the node (a save's answer, a refresh, an undo), so an edit never starts from a stale
 *   value.
 * - Every edit is staged the moment it is committed — Enter, leaving the field, a toggle, an added
 *   or removed property (`commit`). Typing in a field (`edit`) is the only state that is not staged
 *   yet; Esc (`discard`) throws that away.
 * - Staging goes through `stageNodeEdit`: one staged change per node, a patch against the node as
 *   first read, each commit one step for Undo.
 * - A clean drawer adopts a newer stored value than the canvas holds (the summary's value and
 *   token), so an edit is checked against what is stored now.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { stageNodeEdit } from '@/features/versioning/model/stageNodeEdit'
import type { EntityView } from '@/services/versioningApiService'

type Data = Record<string, unknown>

const same = (a: unknown, b: unknown) => {
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

export function useEntityEditSession(node: LineageNode | null, stored: EntityView | null | undefined) {
  const [form, setForm] = useState<Data>(() => ({ ...(node?.data ?? {}) }))
  const [dirty, setDirty] = useState(false)
  const [justStaged, setJustStaged] = useState(false)
  // What an edit and a commit in the same tick (type, then Enter) both read: the latest copy.
  const formRef = useRef(form)
  const dirtyRef = useRef(dirty)

  // Derived during render: a new entity starts a new copy; a clean copy follows its node.
  const [shown, setShown] = useState<{ id: string | null; data: unknown }>({ id: node?.id ?? null, data: node?.data })
  if (node?.id !== shown.id) {
    setShown({ id: node?.id ?? null, data: node?.data })
    setForm({ ...(node?.data ?? {}) })
    setDirty(false)
    setJustStaged(false)
  } else if (node && node.data !== shown.data && !dirty) {
    setShown({ id: node.id, data: node.data })
    setForm({ ...node.data })
  }
  // In step with what was rendered (a new entity, a node followed) before anything can be typed.
  useLayoutEffect(() => {
    formRef.current = form
    dirtyRef.current = dirty
  })

  // Adopt a newer stored value — never over an edit in progress or a staged one.
  useEffect(() => {
    if (dirty || !node || !stored || stored.deleted || stored.kind !== 'node') return
    if (stored.version === (node.data as { version?: string }).version) return
    if (useStagedChangesStore.getState().changes.some((c) => c.targetId === node.id)) return
    useCanvasStore.getState().applyServerNodes([stored.node])
  }, [stored, dirty, node])

  const edit = useCallback((update: (data: Data) => Data) => {
    formRef.current = update(formRef.current)
    dirtyRef.current = true
    setForm(formRef.current)
    setDirty(true)
    setJustStaged(false)
  }, [])

  const stagedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(stagedTimer.current), [])

  /** Stage the copy — after applying `update`, when given. Nothing happens when it holds nothing
   *  new: leaving a field you only looked at is not an edit. */
  const commit = useCallback((update?: (data: Data) => Data) => {
    if (!node) return
    if (!update && !dirtyRef.current) return
    const next = update ? update(formRef.current) : formRef.current
    formRef.current = next
    dirtyRef.current = false
    setForm(next)
    setDirty(false)
    // Said now, not after the next render: the blur that commits may be the click that moves the
    // drawer, and it must not be asked about an edit that is already staged.
    useCanvasStore.getState().setDrawerDirty(false)
    if (same(next, node.data)) return
    stageNodeEdit(node.id, node.data, next as LineageNode['data'])
    setJustStaged(true)
    clearTimeout(stagedTimer.current)
    stagedTimer.current = setTimeout(() => setJustStaged(false), 2500)
  }, [node])

  /** ⌘S / ⌘Enter, and "Stage" in the unsaved-edit prompt: stage whatever is being typed. */
  const stage = useCallback(() => commit(), [commit])

  const discard = useCallback(() => {
    formRef.current = { ...(node?.data ?? {}) }
    dirtyRef.current = false
    setForm(formRef.current)
    setDirty(false)
  }, [node])

  return { form, dirty, justStaged, edit, commit, stage, discard }
}
