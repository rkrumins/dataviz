/**
 * useEntityEditSession — the entity drawer's edit: its working copy of the node, whether it holds
 * anything unstaged, and staging or throwing it away.
 *
 * - The copy is taken when the entity shown changes, and — while nothing is being edited — it
 *   follows the node (a save's answer, a refresh), so an edit never starts from a stale value.
 * - Staging goes through `stageNodeEdit`: one staged change per node, a patch against the node as
 *   first read.
 * - A clean drawer adopts a newer stored value than the canvas holds (the summary's value and
 *   token), so an edit is checked against what is stored now.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { stageNodeEdit } from '@/features/versioning/model/stageNodeEdit'
import type { EntityView } from '@/services/versioningApiService'

type Data = Record<string, unknown>

export function useEntityEditSession(node: LineageNode | null, stored: EntityView | null | undefined) {
  const [form, setForm] = useState<Data>(() => ({ ...(node?.data ?? {}) }))
  const [dirty, setDirty] = useState(false)
  const [justStaged, setJustStaged] = useState(false)

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

  // Adopt a newer stored value — never over an edit in progress or a staged one.
  useEffect(() => {
    if (dirty || !node || !stored || stored.deleted || stored.kind !== 'node') return
    if (stored.version === (node.data as { version?: string }).version) return
    if (useStagedChangesStore.getState().changes.some((c) => c.targetId === node.id)) return
    useCanvasStore.getState().applyServerNodes([stored.node])
  }, [stored, dirty, node])

  const edit = useCallback((update: (data: Data) => Data) => {
    setForm((d) => update(d))
    setDirty(true)
    setJustStaged(false)
  }, [])

  const stagedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(stagedTimer.current), [])

  const stage = useCallback(() => {
    if (!node || !dirty) return
    stageNodeEdit(node.id, node.data, form as LineageNode['data'])
    setDirty(false)
    setJustStaged(true)
    clearTimeout(stagedTimer.current)
    stagedTimer.current = setTimeout(() => setJustStaged(false), 2500)
  }, [node, dirty, form])

  const discard = useCallback(() => {
    setForm({ ...(node?.data ?? {}) })
    setDirty(false)
  }, [node])

  return { form, dirty, justStaged, edit, stage, discard }
}
