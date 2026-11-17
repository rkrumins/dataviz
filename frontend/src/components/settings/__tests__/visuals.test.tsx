/**
 * The explainers: each is a named figure with a caption in words; the compass draws a ghost only
 * when staged values move a dimension; the memory marks move by keyboard and never let the stop
 * mark pass the start mark less its margin; the read timeline scrubs by keyboard; the guard
 * meter's verdict follows the import; the symptom finder leads to the settings and stages the
 * recommended move.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SCHEMA, SETTINGS_BY_KEY } from '../__fixtures__/schema'
import { FACTS, GRAPH_VALUES, PLATFORM_VALUES, SIGNAL_COUNTS } from '../__fixtures__/resolved'
import { compassMoves, compassScores } from '../compass'
import { symptomIndex } from '../search'
import type { Values } from '../types'
import { CopyRoomBar } from '../visuals/CopyRoomBar'
import { GuardMeter } from '../visuals/GuardMeter'
import { MemoryMarks } from '../visuals/MemoryMarks'
import { ReadTimeline } from '../visuals/ReadTimeline'
import { IdleTimeline, RetentionTimeline } from '../visuals/RetentionTimeline'
import { SymptomFinder } from '../visuals/SymptomFinder'
import { TradeoffCompass } from '../visuals/TradeoffCompass'
import { WriteRhythm } from '../visuals/WriteRhythm'

const CURRENT: Values = Object.fromEntries(Object.values(PLATFORM_VALUES).map((r) => [r.key, r.effective]))

describe('TradeoffCompass', () => {
    it('scores each dimension from the verdicts and weights of the settings in force', () => {
        const now = compassScores(SCHEMA.dimensions, SCHEMA.settings, CURRENT)
        const next = compassScores(SCHEMA.dimensions, SCHEMA.settings, { ...CURRENT, 'reads.mode': 'in_place' })
        const read = (pts: typeof now) => pts.find((p) => p.dimension === 'read_speed')!
        expect(read(now).drivers.find((d) => d.key === 'reads.mode')?.contribution).toBeLessThan(0)
        expect(read(next).score).toBeGreaterThan(read(now).score)
        expect(compassMoves(now, next)).toBe(true)
        expect(compassMoves(now, compassScores(SCHEMA.dimensions, SCHEMA.settings, { ...CURRENT }))).toBe(false)
    })

    it('draws a ghost outline, and says it, only when staged values move a dimension', () => {
        const { container, rerender } = render(<TradeoffCompass dimensions={SCHEMA.dimensions} settings={SCHEMA.settings} current={CURRENT} next={CURRENT} />)
        const figure = screen.getByRole('figure', { name: 'What your settings trade' })
        expect(within(figure).getByRole('img', { name: /^Trade-off compass\. Consistency/ })).toBeInTheDocument()
        expect(container.querySelector('[data-series="staged"]')).toBeNull()
        expect(figure).not.toHaveTextContent('With your changes')
        rerender(<TradeoffCompass dimensions={SCHEMA.dimensions} settings={SCHEMA.settings} current={CURRENT} next={{ ...CURRENT, 'reads.mode': 'in_place' }} />)
        expect(container.querySelector('[data-series="staged"]')).not.toBeNull()
        expect(within(figure).getByRole('list', { name: 'Each dimension, in words' })).toHaveTextContent(/Read speed.*with your changes/)
    })

    it('tells what drives a dimension when it is focused', async () => {
        const user = userEvent.setup()
        render(<TradeoffCompass dimensions={SCHEMA.dimensions} settings={SCHEMA.settings} current={CURRENT} />)
        const figure = screen.getByRole('figure', { name: 'What your settings trade' })
        await user.tab()
        expect(screen.getAllByRole('button')[0]).toHaveFocus()
        expect(figure).toHaveAccessibleDescription(/^Consistency: /)
        expect(figure).toHaveAccessibleDescription(/Driven by Read mode/)
    })
})

describe('MemoryMarks', () => {
    function Marks({ onChange }: { onChange: (start: number, stop: number) => void }) {
        const [m, setM] = useState({ start: 85, stop: 75 })
        return (
            <MemoryMarks nodes={FACTS.nodes!} start={m.start} stop={m.stop} margin={5} saved={{ start: 85, stop: 75 }}
                onChange={(start, stop) => { setM({ start, stop }); onChange(start, stop) }} />
        )
    }

    it('names each mark and each node’s gauge, and says which nodes are over the start mark', () => {
        render(<Marks onChange={() => {}} />)
        expect(screen.getByRole('slider', { name: 'Start unloading at' })).toHaveAttribute('aria-valuetext', '85% of memory')
        expect(screen.getByRole('meter', { name: 'Memory of Node 3' })).toHaveAttribute('aria-valuenow', '90')
        expect(screen.getByRole('figure', { name: 'Where unloading starts and stops' })).toHaveAccessibleDescription(/Node 3 \(90%\) is over the start mark/)
    })

    it('moves a mark with the arrow keys and never lets stop pass start less the margin', () => {
        const onChange = vi.fn()
        render(<Marks onChange={onChange} />)
        const stop = screen.getByRole('slider', { name: 'Stop unloading at' })
        const start = screen.getByRole('slider', { name: 'Start unloading at' })
        expect(stop).toHaveAttribute('aria-valuemax', '80')
        for (let i = 0; i < 10; i += 1) fireEvent.keyDown(stop, { key: 'ArrowRight' })
        expect(onChange).toHaveBeenLastCalledWith(85, 80)
        expect(stop).toHaveAttribute('aria-valuenow', '80')
        fireEvent.keyDown(start, { key: 'Home' })
        expect(start).toHaveAttribute('aria-valuenow', '85')
        fireEvent.keyDown(start, { key: 'End' })
        expect(onChange).toHaveBeenLastCalledWith(95, 80)
        fireEvent.keyDown(start, { key: 'PageDown' })
        fireEvent.keyDown(start, { key: 'PageDown' })
        fireEvent.keyDown(start, { key: 'PageDown' })
        expect(onChange).toHaveBeenLastCalledWith(85, 80)
        expect(start).toHaveAttribute('aria-valuemin', '85')
        fireEvent.keyDown(stop, { key: 'Home' })
        expect(onChange).toHaveBeenLastCalledWith(85, 30)
    })

    it('shows marks without moving them when there is nothing to stage', () => {
        render(<MemoryMarks nodes={FACTS.nodes!} start={85} stop={75} />)
        const start = screen.getByRole('slider', { name: 'Start unloading at' })
        expect(start).toHaveAttribute('aria-readonly', 'true')
        fireEvent.keyDown(start, { key: 'ArrowLeft' })
        expect(start).toHaveAttribute('aria-valuenow', '85')
    })
})

describe('ReadTimeline', () => {
    it('scrubs before, while and after with the keyboard, narrating the mode in force and the staged one', () => {
        const latest = SETTINGS_BY_KEY['reads.mode'].choices.find((c) => c.id === 'latest')!.title
        render(<ReadTimeline setting={SETTINGS_BY_KEY['reads.mode']} value="latest" next="in_place" />)
        const figure = screen.getByRole('figure', { name: 'What readers see while a new version lands' })
        const moment = screen.getByRole('slider', { name: 'Moment' })
        expect(moment).toHaveAttribute('aria-valuetext', 'While a new version lands')
        expect(figure).toHaveAccessibleDescription(expect.stringContaining(`readers of “${latest}” see version 6, read from the database`))
        expect(figure).toHaveAccessibleDescription(/With your change: .*“Keep serving, update in place” see version 5, with parts of 6/)
        fireEvent.keyDown(moment, { key: 'ArrowRight' })
        expect(moment).toHaveAttribute('aria-valuetext', 'After it has landed')
        expect(figure).toHaveAccessibleDescription(expect.stringContaining(`After it has landed, readers of “${latest}” see version 6, read from the graph store`))
    })
})

describe('WriteRhythm, CopyRoomBar and the timelines', () => {
    it('WriteRhythm says how much of the node’s time reads get, now and with the change', () => {
        render(<WriteRhythm statementTargetMs={250} pacingRatio={0.5} readPressureRatio={2} next={{ statementTargetMs: 250, pacingRatio: 1, readPressureRatio: 2 }} />)
        const figure = screen.getByRole('figure', { name: 'How a node shares its time while a graph updates' })
        expect(figure).toHaveAccessibleDescription(/Each write of 250 ms is followed by a pause of 125 ms \(50% of the write\), so reads get 33% of the node’s time/)
        expect(figure).toHaveAccessibleDescription(/the pause grows to 500 ms \(200% of the write\): reads get 67%/)
        expect(figure).toHaveAccessibleDescription(/With your changes: .*reads get 50%/)
    })

    it('CopyRoomBar measures each node’s room under its start mark, and says where a copy fits', () => {
        render(<CopyRoomBar graph={FACTS.largestGraph!} copyRoomPct={100} nextCopyRoomPct={220} startPct={80} nodes={FACTS.nodes!} />)
        const figure = screen.getByRole('figure', { name: 'Room for a copy' })
        expect(figure).toHaveAccessibleDescription(
            /Sales lineage is 9\.4 GB\. At 100%, a copy needs 9\.4 GB free under a node’s start mark \(80%\): it fits on 1 of 3 nodes\. With your change \(220%\) it needs 20\.68 GB: it fits on 0\./)
        // Node 2: 16 GB × 80% − 3.2 GB used = 9.6 GB of room (the registry's own figure for this node).
        expect(figure).toHaveTextContent('9.6 GB of room · A copy fits')
    })

    it('RetentionTimeline: pick how long ago a draft closed to see whether its changes are kept', () => {
        render(<RetentionTimeline days={30} nextDays={14} />)
        const figure = screen.getByRole('figure', { name: 'What happens to a closed draft’s changes' })
        const ago = screen.getByRole('slider', { name: 'A draft closed this many days ago' })
        expect(figure).toHaveAccessibleDescription(/A draft closed 15 days ago: its changes are kept for 15 days more\. With your change, they would already be removed\./)
        fireEvent.keyDown(ago, { key: 'End' })
        expect(figure).toHaveAccessibleDescription(/A draft closed 50 days ago: its changes were removed 20 days ago; its record stays\./)
    })

    it('IdleTimeline: pick how long ago a graph was read to see which classes are still loaded', () => {
        render(<IdleTimeline standardIdleSecs={604800} coldlineIdleSecs={3600} />)
        const figure = screen.getByRole('figure', { name: 'When an unread graph unloads' })
        expect(figure).toHaveAccessibleDescription(/Always is still loaded, Standard is still loaded, Coldline is unloaded/)
        fireEvent.keyDown(screen.getByRole('slider', { name: 'Last read this long ago' }), { key: 'End' })
        expect(figure).toHaveAccessibleDescription(/Standard is unloaded, Coldline is unloaded/)
    })
})

describe('GuardMeter', () => {
    // The registry's defaults: stopped at 50% deleted AND 50% made again; early stop under 5% matched.
    const LIMITS = { enabled: true, minLive: 1000, deleteShare: 0.5, createShare: 0.5, minMatchShare: 0.05 }
    const figure = () => screen.getByRole('figure', { name: 'What stops a mistaken replace' })

    it('stops a replace only when it both deletes and makes again past the limits', () => {
        render(<GuardMeter limits={LIMITS} next={{ ...LIMITS, deleteShare: 0.15, createShare: 0.15 }} sample={FACTS.sampleImport!} />)
        expect(figure()).toHaveTextContent('This replace would go through')
        expect(figure()).toHaveAccessibleDescription(/It goes through: it deletes 20% of what it replaces, under 50%\./)
        expect(figure()).toHaveAccessibleDescription(/With your changes: It is stopped: it would delete 20% of what it replaces and make 18\.75% as many again/)
        fireEvent.keyDown(screen.getByRole('slider', { name: 'Items the replace deletes' }), { key: 'End' })
        expect(figure()).toHaveTextContent('This replace would go through')
        expect(figure()).toHaveAccessibleDescription(/a cleanup, not a wrong identifier/)
        fireEvent.keyDown(screen.getByRole('slider', { name: 'Items the replace makes new' }), { key: 'End' })
        expect(figure()).toHaveTextContent('This replace would be stopped')
    })

    it('stops early when its first rows match too little, whether or not the guard is on', () => {
        render(<GuardMeter limits={{ ...LIMITS, enabled: false }} sample={FACTS.sampleImport!} />)
        expect(figure()).toHaveAccessibleDescription(/the replace guard is off, so nothing checks what it deletes/)
        fireEvent.keyDown(screen.getByRole('slider', { name: 'Rows that match an existing item' }), { key: 'Home' })
        expect(figure()).toHaveTextContent('This replace would stop early')
        expect(figure()).toHaveAccessibleDescription(/It stops early: only 0% of its first rows match existing items, under 5%\./)
    })
})

describe('SymptomFinder', () => {
    it('leads from a problem to the settings behind it, and stages the recommended move', async () => {
        const user = userEvent.setup()
        const onStage = vi.fn()
        const onShow = vi.fn()
        render(<SymptomFinder settings={SCHEMA.settings} values={GRAPH_VALUES} onStage={onStage} onShow={onShow} />)
        await user.type(screen.getByRole('textbox', { name: 'Describe the problem' }), 'duplicates')
        const chip = screen.getByRole('button', { name: 'Imports create duplicates instead of updating' })
        await user.click(chip)
        expect(chip).toHaveAttribute('aria-pressed', 'true')
        const result = screen.getByText('Match rows by').closest('li') as HTMLElement
        expect(result).toHaveTextContent('In force: Property sku')
        await user.click(within(result).getByRole('button', { name: 'Use recommended' }))
        expect(onStage).toHaveBeenCalledWith('imports.identifier', 'entity_id')
        await user.click(within(result).getByRole('button', { name: 'Show match rows by' }))
        expect(onShow).toHaveBeenCalledWith('imports.identifier')
    })

    it('says how often each problem happened, leads with what did, and marks what reached its mark', async () => {
        const user = userEvent.setup()
        render(<SymptomFinder settings={SCHEMA.settings} values={PLATFORM_VALUES} signals={SIGNAL_COUNTS} />)
        const signal = (id: string) => SCHEMA.signals.find((s) => s.id === id)!
        const loads = signal('residency.load_waited_for_room')
        const retries = signal('reads.asked_to_retry')
        const chips = within(screen.getByRole('group', { name: 'Common problems' })).getAllByRole('button')
        // 38 loads waited (mark 30) and one replace stopped (mark 1) lead; then the rest that happened.
        expect(chips[0]).toHaveAccessibleName(`${loads.symptom}: happened 38 times in the last 24 h, worth a look`)
        expect(chips[1]).toHaveAccessibleName(`${signal('imports.replace_refused_by_guard').symptom}: happened 1 time in the last 24 h, worth a look`)
        expect(screen.getByRole('button', { name: `${retries.symptom}: happened 12 times in the last 24 h` })).toBeInTheDocument()

        await user.click(chips[0])
        expect(screen.getByRole('list', { name: 'What happened' })).toHaveTextContent(
            `${loads.label}: happened 38 times in the last 24 h. Worth a look.`)
        // The settings behind the signal join the ones whose guidance names the problem.
        for (const key of loads.settings) expect(screen.getByText(SETTINGS_BY_KEY[key].label)).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: new RegExp(`^${retries.symptom}`) }))
        const happened = screen.getByRole('list', { name: 'What happened' })
        expect(happened).toHaveTextContent(`${retries.label}: happened 12 times in the last 24 h.`)
        expect(happened).not.toHaveTextContent('Worth a look')
    })

    it('without signals, lists the problems as before: plain names, most-answered first', () => {
        render(<SymptomFinder settings={SCHEMA.settings} values={PLATFORM_VALUES} />)
        const chips = within(screen.getByRole('group', { name: 'Common problems' })).getAllByRole('button')
        expect(chips.map((c) => c.textContent)).toEqual(symptomIndex(SCHEMA.settings).slice(0, 10).map((e) => e.symptom))
        expect(screen.queryByRole('list', { name: 'What happened' })).toBeNull()
    })
})
