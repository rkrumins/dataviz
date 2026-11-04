/**
 * Save as view — one sheet, whatever is being kept.
 *
 * A search's matches are kept live: a subset view, current every time it opens,
 * any size, with what they reach (everything inside them, what contains them, one
 * lineage step either way) kept as part of its search. A narrowing is kept live
 * when a live view can keep what it reaches; otherwise — chosen entities, levels
 * inside, two or more lineage steps — as a list of its members, brought up to date
 * when it is opened. Where both are possible, the sheet switches between them.
 */
import { useState } from 'react'
import * as LucideIcons from 'lucide-react'

import { Segmented } from '@/components/ui/Segmented'
import { SaveAsViewSheet } from '@/features/live-views/SaveAsViewSheet'
import type { NarrowDraft } from '@/features/narrow/narrowStore'
import type { View } from '@/services/viewApiService'
import type { Predicate } from '@/types/search'
import type { SearchViewDefinition } from '@/types/searchView'

import { liveFromNarrowing, type BoardLayer } from './model'
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

export function SaveAsView({
  source, viewId, viewName, workspaceId, dataSourceId, boardLayers, boardConfig, subset, typeLabel,
  canKeepLive, canKeepList, onNarrowInstead, onClose, onSaved,
}: SaveAsViewProps) {
  const live = source.kind === 'narrowing' ? liveFromNarrowing(source.draft.spec) : null
  const liveReason = !canKeepLive ? 'Live views are turned off here.'
    : live && 'reason' in live ? live.reason : null
  const [kind, setKind] = useState<Kind>(liveReason === null ? 'live' : 'list')

  // A narrowing can be kept either way: a switch beside the title, saying why live can't be when it can't.
  const switcher = source.kind === 'narrowing' && canKeepList ? (
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
            : 'A list of its members, brought up to date when it is opened after its data changed.'}
      </p>
    </div>
  ) : null

  const shaped = live && !('reason' in live) ? live : null
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
        initialInclude={shaped?.include}
        initialWithin={shaped?.within}
        headerExtra={switcher}
        onNarrowInstead={source.kind === 'search' ? onNarrowInstead : undefined}
        onClose={onClose}
        onSaved={onSaved}
      />
    )
  }
  if (source.kind !== 'narrowing') return null
  return (
    <SaveAsViewSheet
      viewId={viewId}
      viewName={viewName}
      workspaceId={workspaceId}
      dataSourceId={dataSourceId ?? undefined}
      draft={source.draft}
      sourceLayerCount={boardLayers.length}
      headerExtra={switcher}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}
