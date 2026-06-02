/**
 * PropertyInsightCharts — the premium insight viz: ranked bars (labels +
 * localized counts + %), the count-up number (full value via title), and
 * the usage gauge (coverage % of view + per-type bars).
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'

import { AnimatedNumber, RankedValueBars, UsageGauge } from '../PropertyInsightCharts'


describe('RankedValueBars', () => {
    it('renders labels, localized counts and percentages, capped at limit', () => {
        render(
            <RankedValueBars
                items={[
                    { label: 'prod', count: 1234 },
                    { label: 'staging', count: 200 },
                    { label: 'dev', count: 66 },
                ]}
                total={1500}
                limit={2}
            />,
        )
        expect(screen.getByText('prod')).toBeInTheDocument()
        expect(screen.getByText('1,234')).toBeInTheDocument()       // toLocaleString
        expect(screen.getByText('82%')).toBeInTheDocument()         // 1234/1500
        expect(screen.queryByText('dev')).not.toBeInTheDocument()   // capped at 2
    })
})


describe('AnimatedNumber', () => {
    it('exposes the full value via title (count-up target)', () => {
        render(<AnimatedNumber value={10000} />)
        expect(screen.getByTitle('10,000')).toBeInTheDocument()
    })
})


describe('UsageGauge', () => {
    it('renders coverage % of the view and a per-type bar', () => {
        render(<UsageGauge total={50} viewTotal={200} byEntityType={[{ type: 'dataset', count: 50 }]} />)
        expect(screen.getByTitle('50')).toBeInTheDocument()                       // animated total
        expect(screen.getByText(/25% of 200 in this view/i)).toBeInTheDocument()  // 50/200
        expect(screen.getByText('dataset')).toBeInTheDocument()                   // per-type bar
    })
})
