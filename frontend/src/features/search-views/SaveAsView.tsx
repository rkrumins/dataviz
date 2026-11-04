/**
 * Save as view — one sheet, whatever is being kept.
 *
 * A search's matches are kept live: a subset view, current every time it opens,
 * any size, with what they reach (everything inside them, what contains them, one
 * lineage step either way) kept as part of its search — or as a list of members,
 * keeping their places where a live view can't follow how its base places them.
 * A narrowing is kept live when a live view can keep what it reaches; otherwise —
 * chosen entities, two or more lineage steps, what is inside its sources and
 * consumers — as a list of its members, brought up to date when it is opened.
 * Where both are possible, the sheet switches between them, and says what a list
 * can't keep of what the live sheet chose.
 */
import { useState } from 'react'
import * as LucideIcons from 'lucide-react'

import { Segmented } from '@/components/ui/Segmented'
import { SaveAsViewSheet } from '@/features/live-views/SaveAsViewSheet'
import type { NarrowDraft } from '@/features/narrow/narrowStore'
import type { View } from '@/services/viewApiService'
import type { Predicate } from '@/types/search'
import type { SearchViewDefinition, SubsetInclude, SubsetWithin } from '@/types/searchView'

import { combinedWith, levelsText, liveFromNarrowing, type BoardLayer } from './model'
import { SaveSearchAsViewSheet } from './SaveSearchAsViewSheet'

export type SaveAsViewSource =
  | { kind: 'search'; predicate: Predicate }
  | { kind: 'narrowing'; draft: NarrowDraft }

export interface SaveAsViewProps {
  source: SaveAsViewSource
  /** The view it is saved from. */
  viewId: string
  viewName: string
  workspaceId: string
  dataSourceId?: string | null
  /** That view's board: the layers a live view follows or copies, and how many there are. */
  boardLayers: BoardLayer[]
  boardConfig?: Record<string, unknown> | null
  /** Saved from inside a subset view: its search, and its base. */
  subset?: { definition: SearchViewDefinition; baseName: string | null } | null
  typeLabel?: (type: string) => string
  /** Whether a live view (`searchViewsEnabled`) and a list of members (`viewMembershipEnabled`) can be made. */
  canKeepLive: boolean
  canKeepList: boolean
  /** From a search: more reach than a live view keeps — narrow first, then save from there. */
  onNarrowInstead?: () => void
  onClose: () => void
  onSaved: (view: View) => void
}

type Kind = 'live' | 'list'

/** The levels inside them a list keeps, past which it keeps everything (`MembershipExpand.children`). */
const LIST_LEVELS = 2

/** A search's matches, and what it keeps beside them, as a list of members: its
 *  search the starting points, one or two levels inside them or everything, one
 *  lineage step either way. The list draws what contains them itself (Show where
 *  they sit), up to the top, and keeps every kind. */
function listFromSearch(predicate: Predicate, choices: { include?: SubsetInclude; within?: SubsetWithin }): NarrowDraft {
  const { include, within = 'view' } = choices
  const levels = include?.contentsLevels
  return {
    spec: {
      v: 1, seeds: { query: predicate }, within,
      expand: { children: include?.contents ? (levels && levels <= LIST_LEVELS ? levels : 'all') : 0,
                upstream: include?.upstream ? 1 : 0, downstream: include?.downstream ? 1 : 0, partnerChildren: 0 },
    },
    seedsLabel: 'the matches of your search',
  }
}

/** What the live sheet chose that a list can't keep, and what it keeps instead, in
 *  words; null when it keeps it all. */
function listCantKeep(include?: SubsetInclude): string | null {
  const inside = include?.contents ? include.contentsLevels ?? 0 : 0
  const up = include?.containers ? include.containersLevels ?? 0 : 0
  const kinds = !!(include?.contents && include.contentsKinds?.length) || !!(include?.containers && include.containersKinds?.length)
  const parts = [
    inside > LIST_LEVELS && [`${levelsText(inside)} inside them`, 'everything inside them'],
    up > 0 && [`what contains them ${levelsText(up)} up`, 'what contains them up to the top'],
    kinds && ['only some kinds', 'every kind'],
  ].filter((p): p is string[] => !!p)
  if (!parts.length) return null
  return `A list can’t keep ${joined(parts.map((p) => p[0]), 'or')}, so it keeps ${joined(parts.map((p) => p[1]), 'and')}.`
}

const joined = (words: string[], last: string) =>
  (words.length > 1 ? `${words.slice(0, -1).join(', ')} ${last} ${words[words.length - 1]}` : words[0])

export function SaveAsView({
  source, viewId, viewName, workspaceId, dataSourceId, boardLayers, boardConfig, subset, typeLabel,
  canKeepLive, canKeepList, onNarrowInstead, onClose, onSaved,
}: SaveAsViewProps) {
  const live = source.kind === 'narrowing' ? liveFromNarrowing(source.draft.spec) : null
  const liveReason = !canKeepLive ? 'Live views are turned off here.'
    : live && 'reason' in live ? live.reason : null
  const [kind, setKind] = useState<Kind>(liveReason === null ? 'live' : 'list')
  const shaped = live && !('reason' in live) ? live : null
  // The live sheet's choices, kept to carry them to a list, and back.
  const [choices, setChoices] = useState<{ include?: SubsetInclude; within?: SubsetWithin }>(
    () => ({ include: shaped?.include, within: shaped?.within }))

  const cantKeep = source.kind === 'search' ? listCantKeep(choices.include) : null

  // Either way: a switch beside the title, saying why live can't be when it can't.
  const switcher = canKeepList && (source.kind === 'narrowing' || liveReason === null) ? (
    <div>
      <Segmented<Kind>
        label="Keep it"
        value={kind}
        onChange={setKind}
        size="md"
        options={[
          { value: 'live', label: 'Live · any size', icon: LucideIcons.Radio, disabled: liveReason !== null },
          { value: 'list', label: 'As a list · up to 5,000', icon: LucideIcons.ListChecks },
        ]}
      />
      <p className="mt-1.5 text-[12px] text-ink-muted leading-snug">
        {liveReason !== null
          ? <>Kept as a list of its members, brought up to date when it is opened. {liveReason}</>
          : kind === 'live'
            ? 'Live: it keeps the search, never a list, so it is current every time it opens.'
            : source.kind === 'search'
              ? `A list of its matches, each where its view places it, brought up to date when it is opened after its data changed.${cantKeep ? ` ${cantKeep}` : ''}`
              : 'A list of its members, brought up to date when it is opened after its data changed.'}
      </p>
    </div>
  ) : null

  const predicate = source.kind === 'search' ? source.predicate : shaped?.predicate
  if (kind === 'live' && liveReason === null && predicate) {
    return (
      <SaveSearchAsViewSheet
        viewId={viewId}
        viewName={viewName}
        workspaceId={workspaceId}
        dataSourceId={dataSourceId}
        predicate={predicate}
        boardLayers={boardLayers}
        boardConfig={boardConfig}
        subset={subset}
        typeLabel={typeLabel}
        initialInclude={choices.include}
        initialWithin={choices.within}
        headerExtra={switcher}
        onChoicesChange={setChoices}
        onKeepAsList={canKeepList ? () => setKind('list') : undefined}
        onNarrowInstead={source.kind === 'search' ? onNarrowInstead : undefined}
        onClose={onClose}
        onSaved={onSaved}
      />
    )
  }
  if (source.kind === 'search' && !canKeepList) return null
  // From inside a subset view, a list is made from its base: it searches there, and
  // takes the base's layers (a subset that follows its base stores none).
  const list = source.kind === 'search' ? (() => {
    const kept = combinedWith(subset?.definition, source.predicate, viewId)
    return { viewId: kept.baseViewId, viewName: subset ? (subset.baseName ?? 'its base view') : viewName,
             draft: listFromSearch(kept.predicate, choices) }
  })() : { viewId, viewName, draft: source.draft }
  return (
    <SaveAsViewSheet
      viewId={list.viewId}
      viewName={list.viewName}
      workspaceId={workspaceId}
      dataSourceId={dataSourceId ?? undefined}
      draft={list.draft}
      sourceLayerCount={boardLayers.length}
      headerExtra={switcher}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}
