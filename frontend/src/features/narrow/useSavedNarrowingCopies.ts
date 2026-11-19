/**
 * useSavedNarrowingCopies — what a saved narrowing showed when its saver saved it, kept in
 * that saver's browser (IndexedDB).
 *
 * Everyone who can open the view can open a saved narrowing and export what it shows now.
 * Its saver can also download what it showed then, without asking again: on saving, the
 * entities it reaches (each with its parent and path) and the flows between them are worked
 * out on the server, as an export is, and the two CSV files are kept here, gzipped.
 *
 * Space is the browser's to give, as for saved traces: past `TRACE_SNAPSHOT_MAX_ROWS` rows
 * no copy is kept, and when the browser refuses one the oldest copies give way first.
 * A browser with no IndexedDB keeps none.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { TRACE_SNAPSHOT_MAX_ROWS } from '@/hooks/lib/traceSnapshot'
import { idbAvailable, idbDelete, idbGet, idbSet } from '@/lib/idbStore'
import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { triggerBrowserDownload } from '@/services/importExportApiService'
import { followMemberSet } from '@/services/memberSetExport'
import type { MembershipSpec } from '@/types/membership'

const indexKey = (userId: string) => `nx:narrowing-copies:v1:${userId}`
const copyKey = (id: string) => `nx:narrowing-copy:v1:${id}`
/** Copies kept per person; the oldest give way. */
const COPIES_MAX = 20
const DOWNLOAD_MS = 120_000

interface CopyFile { name: string; bytes: ArrayBuffer; encoding: 'gzip' | 'none' }
interface CopyRecord { v: 1; savedAt: number; files: CopyFile[] }
interface IndexEntry { id: string; savedAt: number }
const NONE: IndexEntry[] = []

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'

async function through(bytes: ArrayBuffer, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close() } })
  return new Response(source.pipeThrough(stream)).arrayBuffer()
}

function entriesOf(raw: unknown): IndexEntry[] {
  return Array.isArray(raw)
    ? raw.filter((e): e is IndexEntry => typeof e?.id === 'string' && typeof e?.savedAt === 'number')
    : []
}

export interface SavedNarrowingCopies {
  /** Ids of the saved narrowings whose results this browser keeps. */
  ids: ReadonlySet<string>
  /** Work out and keep what `spec` shows. Resolves false when nothing was kept (too large,
   *  out of space, or this browser keeps nothing). */
  keep: (input: { id: string; viewId: string; spec: MembershipSpec; fileBase: string; provider: RemoteGraphProvider }) => Promise<boolean>
  /** Download the files kept for `id`; false when there are none. */
  download: (id: string) => Promise<boolean>
  drop: (id: string) => void
}

export function useSavedNarrowingCopies(userId: string): SavedNarrowingCopies {
  const persistent = idbAvailable() && canCompress()
  const [stored, setStored] = useState<{ userId: string; entries: IndexEntry[] }>({ userId, entries: [] })
  const entries = stored.userId === userId ? stored.entries : NONE

  useEffect(() => {
    if (!persistent) return
    let live = true
    void idbGet<unknown>(indexKey(userId)).then((raw) => { if (live) setStored({ userId, entries: entriesOf(raw) }) })
    return () => { live = false }
  }, [userId, persistent])

  const commit = useCallback(async (next: IndexEntry[]) => {
    setStored({ userId, entries: next })
    await idbSet(indexKey(userId), next)
  }, [userId])

  const keep = useCallback<SavedNarrowingCopies['keep']>(async ({ id, viewId, spec, fileBase, provider }) => {
    if (!persistent) return false
    const answer = await followMemberSet(provider, viewId, { spec, includeEdges: true })
    if (!answer.downloadToken || answer.counts.total > TRACE_SNAPSHOT_MAX_ROWS) return false
    const files: CopyFile[] = []
    for (const [part, name] of [['nodes', `${fileBase}.csv`], ['edges', `${fileBase}-flows.csv`]] as const) {
      const res = await fetchWithTimeout(provider.memberSetDownloadUrl(answer.setId, answer.downloadToken, 'csv', part), { timeoutMs: DOWNLOAD_MS })
      if (!res.ok) return false
      files.push({ name, bytes: await through(await res.arrayBuffer(), new CompressionStream('gzip')), encoding: 'gzip' })
    }
    const record: CopyRecord = { v: 1, savedAt: Date.now(), files }
    let current = entriesOf(await idbGet<unknown>(indexKey(userId))).filter((e) => e.id !== id)
    let kept = await idbSet(copyKey(id), record)
    if (!kept && current.length > 0) {
      // Out of space: the oldest half give way, and it is tried once more.
      const oldest = [...current].sort((a, b) => a.savedAt - b.savedAt).slice(0, Math.ceil(current.length / 2))
      for (const e of oldest) await idbDelete(copyKey(e.id))
      current = current.filter((e) => !oldest.includes(e))
      kept = await idbSet(copyKey(id), record)
    }
    if (!kept) return false
    const next = [...current, { id, savedAt: record.savedAt }].sort((a, b) => b.savedAt - a.savedAt)
    for (const e of next.slice(COPIES_MAX)) await idbDelete(copyKey(e.id))
    await commit(next.slice(0, COPIES_MAX))
    return true
  }, [persistent, userId, commit])

  const download = useCallback(async (id: string) => {
    if (!persistent) return false
    const record = await idbGet<CopyRecord>(copyKey(id))
    if (record?.v !== 1 || !Array.isArray(record.files)) return false
    for (const f of record.files) {
      const bytes = f.encoding === 'gzip' ? await through(f.bytes, new DecompressionStream('gzip')) : f.bytes
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/csv' }))
      triggerBrowserDownload(url, f.name)
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
    return true
  }, [persistent])

  const drop = useCallback((id: string) => {
    if (!persistent) return
    void idbDelete(copyKey(id))
    void idbGet<unknown>(indexKey(userId)).then((raw) => commit(entriesOf(raw).filter((e) => e.id !== id)))
  }, [persistent, userId, commit])

  const ids = useMemo(() => new Set(entries.map((e) => e.id)), [entries])
  return useMemo(() => ({ ids, keep, download, drop }), [ids, keep, download, drop])
}
