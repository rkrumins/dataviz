/**
 * InfoTooltip — small wrapper around ``@radix-ui/react-tooltip`` with
 * the project's tone tokens and a copy-friendly layout.
 *
 * Used by the OperatorPill to explain AND / OR / NOT to non-technical
 * users without the raw ``title`` attribute. Designed so other panel
 * atoms can adopt it later (per-row FIELD/MATCH hints, scope-mode
 * picker, etc.) without re-implementing the chrome.
 *
 * Visual identity:
 *   - rounded-lg, bg-canvas-elevated, subtle border + soft shadow
 *   - 11.5px text, max-width 240px so long copy wraps
 *   - 200 ms open delay so it doesn't fire on incidental hovers
 *   - portal-mounted so it escapes any narrow scroll container
 */
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { type FC, type ReactNode } from 'react'

import { cn } from '@/lib/utils'


export interface InfoTooltipProps {
    /** The element that receives hover/focus. */
    children: ReactNode
    /** Tooltip body. Can be a string or rich JSX (bold, line breaks). */
    content: ReactNode
    /** Preferred side; flips to fit viewport when there's no room. */
    side?: 'top' | 'right' | 'bottom' | 'left'
    /** Alignment along the side. */
    align?: 'start' | 'center' | 'end'
    /** How long the user must hover before the tooltip opens (ms). */
    delayMs?: number
    /** Disable the tooltip entirely (useful when the trigger is in a
     *  disabled state and a tooltip would be misleading). */
    disabled?: boolean
}


export const InfoTooltip: FC<InfoTooltipProps> = ({
    children, content, side = 'top', align = 'center',
    delayMs = 200, disabled,
}) => {
    if (disabled) return <>{children}</>
    return (
        <TooltipPrimitive.Provider delayDuration={delayMs} skipDelayDuration={150}>
            <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                    {children}
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content
                        side={side}
                        align={align}
                        sideOffset={6}
                        collisionPadding={8}
                        className={cn(
                            'z-[9999] max-w-[240px]',
                            'rounded-lg border border-glass-border/80',
                            'bg-canvas-elevated/95 backdrop-blur-md',
                            'shadow-xl shadow-black/40',
                            'px-3 py-2',
                            'text-[11.5px] leading-snug text-ink',
                            'animate-in fade-in zoom-in-95 duration-150',
                        )}
                    >
                        {content}
                        <TooltipPrimitive.Arrow className="fill-canvas-elevated drop-shadow" />
                    </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
    )
}
