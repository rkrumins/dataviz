/**
 * A narrowed canvas, as a link: `?narrow=<token>`.
 *
 * The token carries the SPEC — the seeds (by URN, or the search that finds them)
 * and how far they reach — plus the sender's words for the seeds, shown while the
 * recipient's canvas resolves it. It is a question, not a snapshot: the link
 * resolves against the data as it is when it is opened, through the same
 * server-side resolution everyone shares.
 *
 * Decoding is defensive, as `traceShareCodec` is: a token arrives from outside
 * and must never break the canvas. Anything malformed, out of range or too large
 * decodes to null, and the view opens normally.
 */
import type { Depth, MembershipExpand, MembershipSpec } from '@/types/membership'

import { HOPS_MAX } from './model'

/** Seeds a link carries by URN. Past this a URL stops being pasteable — such a
 *  scope travels as the search that finds it instead. */
export const NARROW_SHARE_URN_CAP = 200

const LABEL_CAP = 200
/** A query seed is a predicate; one this large did not come from the builder. */
const QUERY_JSON_CAP = 8_000

export interface NarrowShareV1 {
  v: 1
  spec: MembershipSpec
  /** The sender's words for the seeds. */
  label?: string
}

export function canShareNarrow(spec: MembershipSpec): boolean {
  return !spec.seeds.urns || spec.seeds.urns.length <= NARROW_SHARE_URN_CAP
}

export function encodeNarrowShare(spec: MembershipSpec, label?: string): string {
  const json = JSON.stringify({ v: 1, spec, ...(label ? { label: label.slice(0, LABEL_CAP) } : {}) })
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function depthOk(v: unknown, top: number): v is Depth {
  return v === 'all' || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= top)
}

function expandOf(raw: unknown): MembershipExpand | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (!depthOk(e.children, 2) || !depthOk(e.upstream, HOPS_MAX)
    || !depthOk(e.downstream, HOPS_MAX) || !depthOk(e.partnerChildren, 1)) return null
  return { children: e.children, upstream: e.upstream, downstream: e.downstream, partnerChildren: e.partnerChildren }
}

export function decodeNarrowShare(raw: string): NarrowShareV1 | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const s = parsed as Record<string, unknown>
    if (s.v !== 1 || typeof s.spec !== 'object' || s.spec === null) return null
    const spec = s.spec as Record<string, unknown>
    if (spec.v !== 1 || (spec.within !== 'view' && spec.within !== 'dataSource')) return null
    const expand = expandOf(spec.expand)
    if (!expand) return null

    const seeds = spec.seeds as Record<string, unknown> | null
    if (typeof seeds !== 'object' || seeds === null) return null
    const urns = seeds.urns
    const query = seeds.query
    if ((urns === undefined) === (query === undefined)) return null
    if (urns !== undefined) {
      if (!Array.isArray(urns) || urns.length === 0 || urns.length > NARROW_SHARE_URN_CAP
        || !urns.every((u) => typeof u === 'string' && u !== '')) return null
    } else if (typeof query !== 'object' || query === null || JSON.stringify(query).length > QUERY_JSON_CAP) {
      return null
    }

    const label = typeof s.label === 'string' && s.label !== '' ? s.label.slice(0, LABEL_CAP) : undefined
    return {
      v: 1,
      spec: {
        v: 1,
        within: spec.within,
        expand,
        seeds: urns !== undefined ? { urns: urns as string[] } : { query: query as MembershipSpec['seeds']['query'] },
      },
      ...(label ? { label } : {}),
    }
  } catch {
    return null
  }
}

/** The page's URL with this narrowing in it (and no other canvas link). */
export function narrowLink(spec: MembershipSpec, label: string | undefined, href = window.location.href): string {
  const url = new URL(href)
  url.searchParams.set('narrow', encodeNarrowShare(spec, label))
  url.searchParams.delete('trace')
  url.searchParams.delete('lens')
  return url.toString()
}
