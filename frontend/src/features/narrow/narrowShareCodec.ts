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
 *
 * A link stays pasteable: one past `NARROW_SHARE_URL_MAX` first drops the seeds'
 * names, and past that is not offered — a narrowing saved with its view has a
 * short link of its own (`?narrowSaved=`).
 */
import type { Depth, MembershipExpand, MembershipSpec } from '@/types/membership'

import { HOPS_MAX } from './model'

/** Seeds a link carries by URN. Past this a URL stops being pasteable — such a
 *  scope travels as the search that finds it instead. */
export const NARROW_SHARE_URN_CAP = 200

/** A link longer than this is not offered: chat tools and mail clients cut long URLs. */
export const NARROW_SHARE_URL_MAX = 7_000

const LABEL_CAP = 200
/** Names a link carries for its seeds, each this long at most. */
const NAMES_CAP = 200
const NAME_CHARS = 120
/** A query seed is a predicate; one this large did not come from the builder. */
const QUERY_JSON_CAP = 8_000

export interface NarrowShareV1 {
  v: 1
  spec: MembershipSpec
  /** The sender's words for the seeds. */
  label?: string
  /** The seeds' names, shown on their chips before the graph answers. */
  names?: Record<string, string>
}

export function canShareNarrow(spec: MembershipSpec): boolean {
  return !spec.seeds.urns || spec.seeds.urns.length <= NARROW_SHARE_URN_CAP
}

/** The names of the spec's URN seeds that a link may carry. */
function namesFor(spec: MembershipSpec, names: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!names || !spec.seeds.urns) return undefined
  const kept = spec.seeds.urns.slice(0, NAMES_CAP)
    .filter((u) => typeof names[u] === 'string' && names[u] !== '')
    .map((u) => [u, names[u]!.slice(0, NAME_CHARS)] as const)
  return kept.length ? Object.fromEntries(kept) : undefined
}

export function encodeNarrowShare(spec: MembershipSpec, label?: string, names?: Record<string, string>): string {
  const kept = namesFor(spec, names)
  const json = JSON.stringify({
    v: 1, spec, ...(label ? { label: label.slice(0, LABEL_CAP) } : {}), ...(kept ? { names: kept } : {}),
  })
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
  // The tables the reach comes to, and their lineage — only ever `true`, and their lineage
  // only with the tables (the server refuses it alone).
  if ((e.partnerHosts !== undefined && e.partnerHosts !== true)
    || (e.partnerLineage !== undefined && (e.partnerLineage !== true || e.partnerHosts !== true))) return null
  return {
    children: e.children, upstream: e.upstream, downstream: e.downstream, partnerChildren: e.partnerChildren,
    ...(e.partnerHosts ? { partnerHosts: true as const } : {}),
    ...(e.partnerLineage ? { partnerLineage: true as const } : {}),
  }
}

/** The names a token carries, kept only for its seeds and only as long as a name may be. */
function namesOf(raw: unknown, urns: readonly string[] | undefined): Record<string, string> | undefined {
  if (!urns || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const given = raw as Record<string, unknown>
  const kept = urns.filter((u) => Object.hasOwn(given, u) && typeof given[u] === 'string' && given[u] !== '')
    .slice(0, NAMES_CAP).map((u) => [u, (given[u] as string).slice(0, NAME_CHARS)] as const)
  return kept.length ? Object.fromEntries(kept) : undefined
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
    const names = namesOf(s.names, urns as string[] | undefined)
    return {
      v: 1,
      spec: {
        v: 1,
        within: spec.within,
        expand,
        seeds: urns !== undefined ? { urns: urns as string[] } : { query: query as MembershipSpec['seeds']['query'] },
      },
      ...(label ? { label } : {}),
      ...(names ? { names } : {}),
    }
  } catch {
    return null
  }
}

/** The page's URL with this narrowing in it (and no other canvas link) — without the
 *  seeds' names when they would make it too long (`namesDropped`), and none (`url` null) when
 *  it is too long even then. */
export function narrowLink(
  spec: MembershipSpec, label: string | undefined, names?: Record<string, string>, href = window.location.href,
): { url: string | null; namesDropped: boolean } {
  const url = new URL(href)
  url.searchParams.delete('trace')
  url.searchParams.delete('lens')
  url.searchParams.delete('narrowSaved')
  const withToken = (token: string) => { url.searchParams.set('narrow', token); return url.toString() }
  const full = withToken(encodeNarrowShare(spec, label, names))
  if (full.length <= NARROW_SHARE_URL_MAX) return { url: full, namesDropped: false }
  const bare = withToken(encodeNarrowShare(spec, label))
  return { url: bare.length <= NARROW_SHARE_URL_MAX ? bare : null, namesDropped: !!namesFor(spec, names) }
}
