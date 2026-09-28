/**
 * The off-canvas STUB — see ghostCues.ts for what it stands for. A file of its
 * own so it stays a pure component module (fast refresh needs that).
 */
import { cn } from '@/lib/utils'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'
import { formatUnitCount } from './connections/connectionUnits'
import { OFF_CANVAS_STUB_WIDTH } from './ghostCues'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

export function OffCanvasStub({
  side,
  count,
  partners,
  x,
  y,
  onOpen,
}: {
  /** `out`: flows leaving the row (stub on its right). `in`: arriving (left). */
  side: 'in' | 'out'
  /** Underlying flows that leave the view on this side. */
  count: number
  /** The entities outside the view they reach — what a click shows. */
  partners: number
  /** The row's edge and centre line, in the badge layer's coordinates. */
  x: number
  y: number
  onOpen?: () => void
}) {
  const one = count === 1
  const said = side === 'out'
    ? `${formatUnitCount(count, 'flows')} ${one ? 'leads' : 'lead'} to entities outside this view`
    : `${formatUnitCount(count, 'flows')} ${one ? 'arrives' : 'arrive'} from entities outside this view`
  const action = onOpen
    ? `Click to see ${partners === 1 ? 'that entity' : `those ${partners.toLocaleString()} entities`} in the Focus Lens.`
    : null
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: side === 'out' ? x : x - OFF_CANVAS_STUB_WIDTH,
        top: y,
        width: OFF_CANVAS_STUB_WIDTH,
        // `y` is where the dashed line sits; the count rides above it.
        transform: 'translateY(-75%)',
      }}
    >
      <InfoTooltip
        side={side === 'out' ? 'right' : 'left'}
        content={<p>{said}.{action && <><br /><span className="text-ink-muted">{action}</span></>}</p>}
      >
        <button
          type="button"
          data-canvas-interactive
          data-off-canvas-stub={side}
          aria-label={action ? `${said}. ${action}` : said}
          onClick={(e) => { e.stopPropagation(); onOpen?.() }}
          disabled={!onOpen}
          className={cn(
            'pointer-events-auto group/stub flex flex-col w-full rounded-md py-0.5',
            side === 'out' ? 'items-start' : 'items-end',
            // The direction's own colour, as on the card's ports.
            side === 'out'
              ? 'text-lineage-out focus-visible:ring-lineage-out/40'
              : 'text-lineage-in focus-visible:ring-lineage-in/40',
            'focus-visible:outline-none focus-visible:ring-2 transition-colors',
          )}
        >
          <span className="px-0.5 text-[9px] font-semibold tabular-nums leading-none">{compact.format(count)}</span>
          {/* The cut edge: dashed out of the card, ending in an open ring —
              an edge that goes somewhere this canvas does not show. */}
          <svg width={OFF_CANVAS_STUB_WIDTH} height="8" viewBox={`0 0 ${OFF_CANVAS_STUB_WIDTH} 8`} aria-hidden
            className={cn('mt-0.5 opacity-70 group-hover/stub:opacity-100', side === 'in' && '-scale-x-100')}>
            <line x1="0" y1="4" x2={OFF_CANVAS_STUB_WIDTH - 7} y2="4" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.5 2.5" />
            <circle cx={OFF_CANVAS_STUB_WIDTH - 4} cy="4" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
      </InfoTooltip>
    </div>
  )
}
