/**
 * viewNarrowingsApi — narrowings saved with a view (`/api/v1/views/{id}/narrowings`).
 *
 * A reader's Narrow, kept with the view for everyone who can open it, under a short link
 * (`?narrowSaved={id}`). It keeps its question (the spec) and what it held when it was
 * saved: the URNs themselves, gzipped, read only when it is opened — so opening it says
 * what is new and what is gone since. The id is made here, so a save that is retried
 * saves once.
 */
import type { MembershipCounts, MembershipResult, MembershipSpec, MembershipTruncation } from '@/types/membership'

import { authFetch } from './apiClient'
import { fetchWithTimeout } from './fetchWithTimeout'
import { isTransientFailure, patientDelayMs } from './graphRequestFailure'

export interface SavedNarrowing {
  id: string
  viewId: string
  name: string
  spec: MembershipSpec
  seedsLabel?: string | null
  seedNames?: Record<string, string> | null
  counts?: MembershipCounts | null
  truncated?: MembershipTruncation[] | null
  dataVersion?: string | null
  /** What it held when saved: how many, whether that was all of it, whether it was kept. */
  held: { count: number; complete: boolean; kept: boolean }
  createdBy?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  /** The caller saved it, or may edit the view. */
  canChange: boolean
}

export interface SavedNarrowingList {
  items: SavedNarrowing[]
  canEdit: boolean
  limits: { perView: number; perUser: number }
}

export interface HeldUpload {
  count: number
  complete: boolean
  urnsGzip: string
}

export interface SavedNarrowingInput {
  name: string
  spec: MembershipSpec
  seedsLabel?: string
  seedNames?: Record<string, string>
  counts?: MembershipCounts
  truncated?: MembershipTruncation[]
  dataVersion?: string
  /** Left out: the URNs already kept stay, while the spec is the same. */
  held?: HeldUpload
}

/** The query key of a view's saved narrowings. */
export const NARROWINGS_QUERY_KEY = 'view-narrowings'

/** URNs the server keeps for one narrowing; past this it keeps the first, and says so. */
export const HELD_MAX = 60_000

const url = (viewId: string, id?: string, part = '') =>
  `/api/v1/views/${encodeURIComponent(viewId)}/narrowings${id ? `/${encodeURIComponent(id)}${part}` : ''}`

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** A new narrowing's id: 12 random base62 characters. */
export function newNarrowingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('')
}

export function listNarrowings(viewId: string, signal?: AbortSignal): Promise<SavedNarrowingList> {
  return authFetch<SavedNarrowingList>(url(viewId), { signal })
}

export function getNarrowing(viewId: string, id: string, signal?: AbortSignal): Promise<SavedNarrowing> {
  return authFetch<SavedNarrowing>(url(viewId, id), { signal })
}

export function putNarrowing(viewId: string, id: string, body: SavedNarrowingInput): Promise<SavedNarrowing> {
  return authFetch<SavedNarrowing>(url(viewId, id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Save it under its id — so a server that was slow, busy or briefly away is asked again as
 *  it was, and it is saved once. */
export async function saveNarrowing(viewId: string, id: string, body: SavedNarrowingInput, attempts = 4): Promise<SavedNarrowing> {
  for (let n = 0; ; n++) {
    try {
      return await putNarrowing(viewId, id, body)
    } catch (err) {
      if (n + 1 >= attempts || !isTransientFailure(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, patientDelayMs(err, n)))
    }
  }
}

export function deleteNarrowing(viewId: string, id: string): Promise<void> {
  return authFetch<void>(url(viewId, id), { method: 'DELETE' })
}

// ── What it held ──────────────────────────────────────────────────────────

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })
  return new Uint8Array(await new Response(source.pipeThrough(stream)).arrayBuffer())
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

/** Every entity a result holds: its members and those whose whole inside is in it. */
export function heldUrns(result: Pick<MembershipResult, 'members' | 'wholeSubtree'>): string[] {
  return [...new Set([...result.members.map((m) => m.urn), ...result.wholeSubtree])].sort()
}

/** What a result held, to keep with its narrowing — null where this browser can't gzip
 *  (it is then saved without, and opening it says nothing of what changed). */
export async function packHeld(result: Pick<MembershipResult, 'members' | 'wholeSubtree' | 'truncated'>): Promise<HeldUpload | null> {
  if (!canCompress()) return null
  const all = heldUrns(result)
  const kept = all.slice(0, HELD_MAX)
  const gz = await through(new TextEncoder().encode(kept.join('\n')), new CompressionStream('gzip'))
  return { count: kept.length, complete: kept.length === all.length && result.truncated.length === 0, urnsGzip: base64(gz) }
}

/** The URNs a narrowing held when saved, sorted — null when it kept none, or this browser
 *  can't read them. */
export async function readHeld(viewId: string, id: string, signal?: AbortSignal): Promise<string[] | null> {
  if (!canCompress()) return null
  const res = await fetchWithTimeout(url(viewId, id, '/held'), { signal })
  if (res.status === 204) return null
  if (!res.ok) throw Object.assign(new Error(`held: ${res.status}`), { status: res.status })
  const text = new TextDecoder().decode(await through(new Uint8Array(await res.arrayBuffer()), new DecompressionStream('gzip')))
  return text.split('\n').filter(Boolean)
}

/** What is new and what is gone since a narrowing was saved. `approximate`: one side or
 *  the other held more than it listed. */
export interface SinceSaved {
  added: number
  removed: number
  approximate: boolean
}

export function narrowingSince(
  held: readonly string[], heldComplete: boolean, now: Pick<MembershipResult, 'members' | 'wholeSubtree' | 'truncated'>,
): SinceSaved {
  const then = new Set(held)
  const current = new Set(heldUrns(now))
  let added = 0
  for (const u of current) if (!then.has(u)) added++
  let removed = 0
  for (const u of then) if (!current.has(u)) removed++
  return { added, removed, approximate: !heldComplete || now.truncated.length > 0 }
}
