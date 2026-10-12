/**
 * ViewScopeBadge — the three layers a view rests on, as pills.
 *
 * A coloured workspace pill, an emerald data source pill, and a sky provider
 * pill. Used across Explorer cards, list rows, hero, recent strip and the
 * preview drawer — which is why it is worth being exact here: one edit reaches
 * every catalogue surface in the app.
 *
 * EACH PILL SAYS WHAT IT IS, not just what it is called. Three pills sat in a
 * row wearing three colours and named three proper nouns — "Major Refactor
 * Agg", "Perf-Load-Test-Solidatus", "Falkor Docker" — with nothing on screen
 * saying which was a workspace, which a data source and which the database
 * serving it. A reader who did not already know the platform could not tell
 * them apart, and the only help was a native `title` that repeated the name
 * they had just read. They now carry the app's own HoverTip, naming the layer
 * and what it means for this view, in the same voice the canvas uses for the
 * same three facts.
 *
 * THE TINTS ARE REAL AGAIN. The source and provider pills were authored
 * `bg-emerald-500/8` and `bg-sky-500/8`, and `8` is not on Tailwind's opacity
 * scale — an off-scale modifier compiles to no rule at all, so for however long
 * that has shipped both pills have had NO fill on all five surfaces, reading as
 * bare text in a hairline outline while the workspace pill beside them was
 * properly tinted. The bracket form is exact and always compiles.
 */
import { Database, Layers, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { workspaceColor } from '@/lib/workspaceColor'

interface ViewScopeBadgeProps {
  workspaceId: string
  workspaceName?: string | null
  dataSourceId?: string | null
  dataSourceName?: string | null
  /** Provider the data source is built from (resolved via catalog → provider). */
  providerName?: string | null
  providerType?: string | null
  /** The semantic layer the source is read through, from the same resolver. */
  ontologyName?: string | null
  ontologyVersion?: number | null
  /**
   * Name the provider inside the DATA SOURCE's tip instead of giving it a pill
   * of its own.
   *
   * A catalogue card had six chips in a 250px row and wrapped onto three lines.
   * The provider is infrastructure — nobody browsing sixty-five views picks one
   * by its graph database — and it is a PROPERTY OF THE SOURCE, so folding it
   * into that pill's tip loses nothing and buys back a whole chip.
   *
   * The drawer leaves this off: it has the width, and the chain below spells
   * all four layers out in full anyway.
   */
  foldProviderIntoSource?: boolean
  /**
   * Which pills to render. The card calls this twice — the short facts on one
   * row, the data source alone on the next — because at 250px two names side
   * by side truncate to "Perf-Load-Test-S…" and "Synodic Default O…", which
   * tells a reader less than nothing. Default is everything, as every other
   * surface wants.
   */
  parts?: ReadonlyArray<'workspace' | 'source' | 'provider' | 'ontology'>
  /** Let a pill use the whole track it was given. Only meaningful when the
   *  caller has already put it on a row of its own — otherwise one long name
   *  starves everything beside it. */
  wide?: boolean
  /**
   * Makes the semantic layer a GLYPH BUTTON rather than a named pill.
   *
   * Its name is the longest of the four and the least room is left for it, so
   * on a card it holds an icon and gives its name to the tip. It must look and
   * behave like a control — an earlier pass rendered a bare glyph with no hover
   * state, no focus ring and no action, and two anonymous squares read as
   * broken pills rather than as anything one could use.
   */
  onOntologyClick?: () => void
  /** 'sm' for cards/rows, 'md' for hero/drawer */
  size?: 'sm' | 'md'
  /** Hide the workspace pill — for contexts already scoped to one workspace
   *  (e.g. the workspace-detail Views tab) where it's redundant on every row. */
  hideWorkspace?: boolean
}

export function ViewScopeBadge({
  workspaceId,
  workspaceName,
  dataSourceId,
  dataSourceName,
  providerName,
  providerType,
  ontologyName,
  ontologyVersion,
  size = 'sm',
  hideWorkspace,
  foldProviderIntoSource,
  parts,
  wide,
  onOntologyClick,
}: ViewScopeBadgeProps) {
  const wsColor = workspaceColor(workspaceId)
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs'
  // Cap each pill so a long name truncates on ONE line (…) with a title
  // tooltip, instead of wrapping to multiple lines or overflowing a narrow
  // table column. min-w-0 lets the pill shrink further inside a constrained
  // flex track (e.g. the list-row scope cell).
  const pillMax = wide ? 'max-w-full' : size === 'sm' ? 'max-w-[130px]' : 'max-w-[200px]'
  const wants = (p: 'workspace' | 'source' | 'provider' | 'ontology') => !parts || parts.includes(p)

  return (
    <>
      {/* Workspace pill */}
      {!hideWorkspace && wants('workspace') && (
        <HoverTip
          label={workspaceName ? `Workspace · ${workspaceName}` : 'Workspace'}
          detail={
            workspaceName
              ? `This view belongs to ${workspaceName}. Who can find and open it is decided here.`
              : 'The workspace this view belongs to. You are not a member, so its name is not shown.'
          }
        >
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 font-semibold leading-none min-w-0',
              pillMax,
              textSize,
              wsColor.bg,
              wsColor.text,
              wsColor.border,
            )}
          >
            {/* Non-members have no name for this workspace — a neutral label
                beats leaking a raw UUID into the UI. */}
            <span className="truncate">{workspaceName ?? 'Workspace'}</span>
          </span>
        </HoverTip>
      )}

      {/* Data source pill */}
      {dataSourceId && wants('source') && (
        <HoverTip
          label={dataSourceName ? `Data source · ${dataSourceName}` : 'Data source'}
          detail={
            (dataSourceName
              ? `Everything in this view is drawn from ${dataSourceName}.`
              : 'Where this view draws its data from.')
            + (foldProviderIntoSource && providerName
              ? ` Served by ${providerName}${providerType ? ` (${providerType})` : ''}.`
              : '')
          }
        >
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/[0.08] px-2 py-0.5 font-medium leading-none text-emerald-600 dark:text-emerald-400 min-w-0',
              pillMax,
              textSize,
            )}
          >
            <Database className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{dataSourceName ?? 'Data source'}</span>
          </span>
        </HoverTip>
      )}

      {/* Provider pill */}
      {providerName && !foldProviderIntoSource && wants('provider') && (
        <HoverTip
          label={`Graph provider · ${providerName}`}
          detail={
            providerType
              ? `The graph database serving this view — ${providerType}. It answers every question the canvas asks.`
              : 'The graph database serving this view. It answers every question the canvas asks.'
          }
        >
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/[0.08] px-2 py-0.5 font-medium leading-none text-sky-600 dark:text-sky-400 min-w-0',
              pillMax,
              textSize,
            )}
          >
            <Server className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{providerName}</span>
          </span>
        </HoverTip>
      )}

      {/* Semantic layer pill — the ontology the source is read through.
          The catalogue could never name this before: a view's own
          `contextModelName` is a different, usually-empty field, while the id
          that resolves to the ontology lives on the DATA SOURCE. It is the
          same fact the view's own details panel prints as "Semantic layer". */}
      {ontologyName && wants('ontology') && (
        <HoverTip
          label={`Semantic layer · ${ontologyName}`}
          detail={
            `The vocabulary this view reads its data through — the entity types and `
            + `relationships it can show`
            + (ontologyVersion != null ? `, at version ${ontologyVersion}.` : '.')
            + (onOntologyClick ? ' Open the preview for the full picture.' : '')
          }
        >
          {onOntologyClick ? (
            <button
              type="button"
              aria-label={`Semantic layer: ${ontologyName}`}
              onClick={(e) => {
                // The whole card is a button too; without this the click
                // lands on both and the tip's own action is indistinguishable
                // from an ordinary card press.
                e.stopPropagation()
                onOntologyClick()
              }}
              className={cn(
                'inline-flex items-center justify-center rounded-full border border-indigo-500/25 bg-indigo-500/[0.08]',
                'h-[18px] w-[18px] text-indigo-600 dark:text-indigo-400 shrink-0',
                'transition-colors duration-150 hover:bg-indigo-500/[0.16] hover:border-indigo-500/40',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
              )}
            >
              <Layers className="h-2.5 w-2.5" />
            </button>
          ) : (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border border-indigo-500/20 bg-indigo-500/[0.08] px-2 py-0.5 font-medium leading-none text-indigo-600 dark:text-indigo-400 min-w-0',
                pillMax,
                textSize,
              )}
            >
              <Layers className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{ontologyName}</span>
            </span>
          )}
        </HoverTip>
      )}

    </>
  )
}
