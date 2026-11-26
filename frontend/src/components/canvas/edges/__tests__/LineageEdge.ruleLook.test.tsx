/**
 * LineageEdge — a line a relationship rule paints: drawn in the rule's
 * colour, dash and width, carrying the rules' chips at its middle; a dimmed,
 * traced or highlighted line shows that instead, and a dimmed one no chips.
 */
import type { CSSProperties, ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { Position } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'

import type { RuleLineLook } from '../../ruleLines'
import { LineageEdge, type LineageEdgeProps } from '../LineageEdge'


vi.mock('@xyflow/react', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@xyflow/react')>()),
    // The line itself, its style as drawn; labels in place, with no flow around them.
    BaseEdge: ({ style }: { style?: CSSProperties }) => <path data-testid="line" style={style} />,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
}))


const LOOK: RuleLineLook = {
    color: '#ef4444', dash: 'dashed', width: 4,
    chips: [{ id: 'r1', name: 'Streams', color: '#ef4444', target: 'relationships' },
        { id: 'r2', name: 'Unowned', color: '#3b82f6', target: 'relationships' }],
}

function draw(data: LineageEdgeProps['data']) {
    const props = {
        id: 'e-1', source: 'a', target: 'b', sourceX: 0, sourceY: 0, targetX: 200, targetY: 0,
        sourcePosition: Position.Right, targetPosition: Position.Left, data,
    } as unknown as LineageEdgeProps
    render(<svg><LineageEdge {...props} /></svg>)
    return screen.getByTestId('line')
}


describe('LineageEdge — a relationship rule’s look', () => {
    it('draws the rule’s colour, dash and width, with its chips at the middle', () => {
        const line = draw({ edgeType: 'TRANSFORMS', ruleLook: LOOK })
        expect(line.style.stroke).toBe('rgb(239, 68, 68)')
        expect(line.style.strokeWidth).toBe('4')
        expect(line.style.strokeDasharray).toBe('12 8')
        expect(screen.getByTestId('rule-line-chips')).toHaveTextContent('StreamsUnowned')
    })

    it('draws a dotted line in round dots', () => {
        const line = draw({ edgeType: 'TRANSFORMS', ruleLook: { ...LOOK, dash: 'dotted', width: 2 } })
        expect(line.style.strokeDasharray).toBe('0 4')
        expect(line.style.strokeLinecap).toBe('round')
    })

    it('a line no rule paints keeps its type’s look and carries no chips', () => {
        const line = draw({ edgeType: 'TRANSFORMS' })
        expect(line.style.stroke).toContain('#edge-gradient-e-1')
        expect(line.style.strokeWidth).toBe('1.5')
        expect(line.style.strokeDasharray).toBe('')
        expect(screen.queryByTestId('rule-line-chips')).not.toBeInTheDocument()
    })

    it('a dimmed line says that instead, and carries no chips', () => {
        const dimmed = draw({ edgeType: 'TRANSFORMS', ruleLook: LOOK, isDimmed: true })
        expect(dimmed.style.stroke).toBe('rgb(156, 163, 175)')
        expect(screen.queryByTestId('rule-line-chips')).not.toBeInTheDocument()
    })

    it('a traced line keeps the rules’ chips but draws the trace', () => {
        const traced = draw({ edgeType: 'TRANSFORMS', ruleLook: LOOK, isTraced: true })
        expect(traced.style.stroke).toBe('rgb(192, 132, 252)')
        expect(traced.style.strokeDasharray).toBe('')
        expect(screen.getByTestId('rule-line-chips')).toBeInTheDocument()
    })
})
