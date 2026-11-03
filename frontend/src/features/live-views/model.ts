/**
 * Views made from a query — what the screens share: the requests a narrowing
 * becomes, the meter against the limit and what helps when it is over, and the
 * words for how keeping a view up to date is going.
 *
 * Pure: no React, no store. The wire types are `@/types/membership`.
 */
import { usesLineage } from '@/features/narrow/model'
import type {
  FromMembersRequest,
  KeepLayers,
  MembershipLayout,
  MembershipMode,
  MembershipOrigin,
  MembershipPlan,
  MembershipSource,
  MembershipSpec,
  MembershipStatus,
  PlanRequest,
} from '@/types/membership'

// ── The request a narrowing becomes ────────────────────────────────────────

export type LayoutChoice = 'source' | 'template' | 'auto' | 'stages'

export interface SaveChoices {
  choice: LayoutChoice
  /** For layers copied or made for the view: keep the empty ones too? */
  keep: KeepLayers
  /** Draw each member inside its containers. */
  nest: boolean
  templateId?: string
  /** The template's layers, fitted to this data source. */
  templateLayers?: Array<Record<string, unknown>>
}

/** The narrowing as a view's source. A search is searched in the view it was
 *  made in; chosen entities are what they are wherever they are read. */
export function sourceOf(spec: MembershipSpec, viewId: string): MembershipSource {
  return spec.seeds.query !== undefined ? { spec, readIn: viewId } : { spec }
}

export function layoutOf(choices: SaveChoices, sourceViewId: string): MembershipLayout {
  const nest = choices.nest
  switch (choices.choice) {
    case 'source': return { kind: 'source', sourceViewId, nest }
    case 'template': return { kind: 'template', templateId: choices.templateId, nest }
    case 'auto': return { kind: 'auto', nest }
    case 'stages': return { kind: 'stages', nest }
  }
}

export function planRequestOf(spec: MembershipSpec, viewId: string, choices: SaveChoices): PlanRequest {
  return {
    sources: [sourceOf(spec, viewId)],
    layout: layoutOf(choices, viewId),
    keep: choices.keep,
    ...(choices.choice === 'template' && choices.templateLayers ? { layers: choices.templateLayers } : {}),
  }
}

export function createRequestOf(args: {
  name: string
  description?: string
  visibility: 'private' | 'workspace'
  mode: MembershipMode
  workspaceId: string
  dataSourceId?: string
  spec: MembershipSpec
  viewId: string
  choices: SaveChoices
  origin: MembershipOrigin
}): FromMembersRequest {
  const plan = planRequestOf(args.spec, args.viewId, args.choices)
  return {
    name: args.name.trim(),
    ...(args.description?.trim() ? { description: args.description.trim() } : {}),
    visibility: args.visibility,
    workspaceId: args.workspaceId,
    ...(args.dataSourceId ? { dataSourceId: args.dataSourceId } : {}),
    mode: args.mode,
    sources: plan.sources,
    layout: plan.layout,
    keep: plan.keep,
    ...(plan.layers ? { layers: plan.layers } : {}),
    provenance: { origin: args.origin, viewId: args.viewId },
  }
}

export interface LayoutOffer {
  choice: LayoutChoice
  available: boolean
  /** Why not, in words, when it isn't. */
  reason?: string
}

/** Which layouts fit this narrowing, and why the others don't. */
export function layoutOffers(spec: MembershipSpec, sourceLayers: number, templatesEnabled: boolean): LayoutOffer[] {
  return [
    { choice: 'source', available: sourceLayers > 0, reason: sourceLayers > 0 ? undefined : 'This view has no layers to copy.' },
    { choice: 'template', available: templatesEnabled, reason: templatesEnabled ? undefined : 'Layout templates are turned off for this deployment.' },
    { choice: 'auto', available: true },
    {
      choice: 'stages',
      available: usesLineage(spec.expand),
      reason: usesLineage(spec.expand) ? undefined : 'Only for a reach with sources or consumers.',
    },
  ]
}

// ── The meter ──────────────────────────────────────────────────────────────

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** "1,234 entities + 87 containers = 1,321 of 5,000". */
export function meterText(plan: MembershipPlan): string {
  const parts = [count(plan.members, 'entity', 'entities')]
  if (plan.containers) parts.push(count(plan.containers, 'container'))
  if (plan.included) parts.push(`${plan.included.toLocaleString()} always included`)
  const sum = parts.length > 1 ? `${parts.join(' + ')} = ${plan.keys.toLocaleString()}` : parts[0]
  return `${sum} of ${plan.limit.toLocaleString()}`
}

/** What would bring a result over the limit under it — only what is true of this one. */
export function overLimitHelp(plan: MembershipPlan, spec: MembershipSpec, nest: boolean): string[] {
  if (!plan.overCap) return []
  const help: string[] = []
  const withoutContainers = plan.members + plan.included
  if (nest && plan.containers > 0) {
    help.push(withoutContainers <= plan.limit
      ? `Turn off “Show where they sit”: without the ${count(plan.containers, 'container')} around them it holds ${withoutContainers.toLocaleString()}, which fits.`
      : `Turning off “Show where they sit” leaves ${withoutContainers.toLocaleString()} — still more than ${plan.limit.toLocaleString()}.`)
  }
  if (typeof spec.expand.children === 'number' && spec.expand.children > 0) {
    help.push('Reach “everything inside” instead of a number of levels: each starting point is then a single entry, however much is inside it.')
  }
  help.push('Narrow the query, or start from fewer entities.')
  return help
}

/** A search's first matches only: said before the view is saved. */
export function seedCapNote(plan: MembershipPlan | null): string | null {
  const capped = plan?.truncated.find((t) => t.reason === 'seed_cap')
  return capped
    ? `The search found more than ${capped.limit.toLocaleString()} matches. The view starts from the first ${capped.limit.toLocaleString()}, and keeps to them as the data changes.`
    : null
}

// ── How keeping it is going ────────────────────────────────────────────────

export type StatusTone = 'ok' | 'busy' | 'attention' | 'problem' | 'quiet'

export interface StatusWords {
  label: string
  tone: StatusTone
  /** What it means, and what to do about it. */
  detail: string
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function statusWords(status: MembershipStatus): StatusWords {
  const d = status.detail ?? {}
  switch (status.status) {
    case 'ok':
      return { label: 'Up to date', tone: 'ok', detail: 'Its members follow the data: what newly matches arrives, what stops matching leaves.' }
    case 'partial':
      return { label: 'Up to date, within limits', tone: 'attention', detail: 'The last update reached a limit — what it reached is shown.' }
    case 'pending':
      return d.reason === 'graph_busy' || d.reason === 'short_answer'
        ? { label: 'Waiting to update', tone: 'attention', detail: 'The graph didn’t answer in full last time, so the view kept its members. Refresh again in a moment.' }
        : { label: 'Waiting to update', tone: 'attention', detail: 'A change is waiting to be worked out. Refresh now to see it.' }
    case 'updating':
      return { label: 'Updating…', tone: 'busy', detail: 'Working out its members again.' }
    case 'over_cap': {
      const keys = num(d.keys)
      const limit = num(d.limit) ?? status.limit
      return {
        label: 'Too many to keep',
        tone: 'problem',
        detail: `${keys !== null ? `The query now reaches ${keys.toLocaleString()} entries` : 'The query now reaches more entries'} — more than the ${limit.toLocaleString()} a view holds. It keeps its last members. Narrow the query to bring it back under.`,
      }
    }
    case 'held': {
      const removed = num(d.removed)
      const of = num(d.of)
      return {
        label: 'An update is waiting for you',
        tone: 'attention',
        detail: removed !== null && of !== null
          ? `An update would remove ${removed.toLocaleString()} of ${of.toLocaleString()}. Apply it, or keep the view as it is.`
          : 'An update would remove much of the view. Apply it, or keep the view as it is.',
      }
    }
    case 'failed':
      return { label: 'Couldn’t update', tone: 'problem', detail: 'The graph couldn’t be read. The view keeps its last members. Try again.' }
    case 'paused':
      return { label: 'Paused', tone: 'quiet', detail: 'Updates are paused while the data loads.' }
    case 'source_missing':
      return { label: 'Can’t search', tone: 'problem', detail: 'The view its query is searched in is gone. The view keeps its last members.' }
    case 'frozen':
      return { label: 'Snapshot', tone: 'quiet', detail: 'Its members stay as they are. Resume updates to keep it in step with the data.' }
  }
}

/** The header chip: "Auto-updating · 1,234", or "Snapshot · 3 Nov". */
export function chipText(status: MembershipStatus, now: Date = new Date()): string {
  const members = status.counts?.members ?? status.keys
  if (status.mode !== 'live') {
    const at = status.lastAppliedAt ? new Date(status.lastAppliedAt) : null
    const when = at && !Number.isNaN(at.getTime())
      ? at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
      : null
    return when ? `Snapshot · ${when}` : 'Snapshot'
  }
  return `Auto-updating · ${members.toLocaleString()}`
}

/** "3 new, 1 left" — what one update changed. */
export function diffText(diff: { added?: number; removed?: number; moved?: number } | null | undefined): string {
  if (!diff) return 'No changes'
  const parts: string[] = []
  if (diff.added) parts.push(`${diff.added.toLocaleString()} new`)
  if (diff.removed) parts.push(`${diff.removed.toLocaleString()} left`)
  if (diff.moved) parts.push(`${diff.moved.toLocaleString()} moved`)
  return parts.length ? parts.join(', ') : 'No changes'
}

// ── Members on the canvas ──────────────────────────────────────────────────

export type MemberAction = 'exclude' | 'include' | 'uninclude'

/** What an editor can do with one entity of a view made from a query: keep a
 *  member out, always include it, or let the query decide again about one they
 *  included. An entity without its own entry comes with a member whole, and
 *  goes with it: nothing to do with it alone. */
export function memberActionsFor(entry: { assignedBy?: string } | undefined): MemberAction[] {
  if (!entry) return []
  return entry.assignedBy === 'query' ? ['include', 'exclude'] : ['uninclude', 'exclude']
}
