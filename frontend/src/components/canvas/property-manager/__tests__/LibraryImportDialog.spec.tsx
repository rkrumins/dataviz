/**
 * LibraryImportDialog — a library file is read, the server says item by
 * item what importing it would do (for the way it would land), and only
 * "Import" changes the view, whose library then shows the result.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const importViewLibrary = vi.hoisted(() => vi.fn())
vi.mock('@/services/viewLibraryService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/viewLibraryService')>()),
    importViewLibrary,
}))

import type { LibraryImportResult } from '@/services/viewLibraryService'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useViewLibraryStore } from '@/store/viewLibraryStore'

import { LibraryImportDialog } from '../LibraryImportDialog'


const pack = {
    format: 'synodic.view-library', version: 1, exportedAt: '2026-09-20T10:00:00Z',
    source: { viewId: 'src', viewName: 'Data Lineage' },
    displayRules: [
        { id: 'r1', name: 'PII', color: '#6366f1', predicate: { kind: 'hasProperty', key: 'pii' } },
        { id: 'r2', name: 'Owned', color: '#6366f1', predicate: { kind: 'hasProperty', key: 'owner' } },
    ],
    savedQueries: [{ id: 'q1', name: 'One hash', predicate: {
        kind: 'property', key: 'gvHash', op: 'eq', value: '__HASH__', valueType: 'number' } }],
}

/** The pack as a file holds it — with a 64-bit integer no double can hold
 *  exactly, which must reach the server as those digits. */
const PACK_TEXT = JSON.stringify(pack).replace('"__HASH__"', '-3746471915534727999')

function preview(over: Partial<LibraryImportResult> = {}): LibraryImportResult {
    return {
        strategy: 'merge', dryRun: true, added: 1, skipped: 1, refused: 1, removed: 0,
        items: [
            { kind: 'rule', name: 'PII', action: 'add', newName: 'PII (2)', warnings: [
                "Refers to entity types this view doesn't show: column"] },
            { kind: 'rule', name: 'Owned', action: 'skip', reason: 'Already in this view.', warnings: [] },
            { kind: 'query', name: 'One hash', action: 'refuse', reason: 'predicate has 99 leaves (max 64)', warnings: [] },
        ],
        ...over,
    }
}

function file(content: string) {
    return new File([content], 'lineage.library.json', { type: 'application/json' })
}

async function chooseFile(content = PACK_TEXT) {
    const input = screen.getByLabelText('Library file')
    fireEvent.change(input, { target: { files: [file(content)] } })
}

function renderDialog(onImported = vi.fn()) {
    render(<LibraryImportDialog viewId="v1" branchId={null} onClose={vi.fn()} onImported={onImported} />)
    return onImported
}


beforeEach(() => {
    importViewLibrary.mockReset()
    useViewLibraryStore.setState({ viewId: 'v1', branchId: null, status: 'ready', canEdit: true })
    useReferenceModelStore.setState({ displayRules: [] })
})


describe('LibraryImportDialog', () => {
    it('previews what the file would do, item by item', async () => {
        importViewLibrary.mockResolvedValueOnce(preview())
        renderDialog()
        await chooseFile()

        expect(await screen.findByText('From “Data Lineage”')).toBeInTheDocument()
        expect(screen.getByText(/2 display rules · 1 saved query/)).toBeInTheDocument()
        expect(await screen.findByText("1 to add · 1 already here · 1 can't be imported")).toBeInTheDocument()
        expect(screen.getByText(/as “PII \(2\)”/)).toBeInTheDocument()
        expect(screen.getByText("Refers to entity types this view doesn't show: column")).toBeInTheDocument()
        expect(screen.getByText('predicate has 99 leaves (max 64)')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Import 1 item/ })).toBeEnabled()

        const [viewId, sent, options] = importViewLibrary.mock.calls[0]
        expect(viewId).toBe('v1')
        expect(options).toEqual({ strategy: 'merge', dryRun: true, branchId: null })
        expect(sent.savedQueries[0].predicate.value).toBe('-3746471915534727999')
    })

    it('asks again when the way it lands changes — and a replace says what it removes', async () => {
        importViewLibrary.mockResolvedValueOnce(preview())
            .mockResolvedValueOnce(preview({ strategy: 'replace', removed: 3 }))
        renderDialog()
        await chooseFile()
        await screen.findByText(/1 to add/)

        await userEvent.setup().click(screen.getByRole('radio', { name: /Replace/ }))
        expect(await screen.findByText(/First removes this view's 3 rules and saved queries/)).toBeInTheDocument()
        expect(importViewLibrary.mock.calls[1][2]).toMatchObject({ strategy: 'replace', dryRun: true })
        expect(screen.getByRole('button', { name: /Replace with 1 item/ })).toBeEnabled()
    })

    it('imports on request, and the view\'s library shows the result', async () => {
        const rule = { id: 'rule_new', name: 'PII (2)', color: '#6366f1', predicate: {}, enabled: true, createdAt: 'x' }
        const done = preview({
            dryRun: false,
            library: { viewId: 'v1', displayRules: [rule], savedQueries: [], canEdit: true },
        })
        importViewLibrary.mockResolvedValueOnce(preview()).mockResolvedValueOnce(done)
        const onImported = renderDialog()
        await chooseFile()
        await screen.findByText(/1 to add/)

        await userEvent.setup().click(screen.getByRole('button', { name: /Import 1 item/ }))
        expect(importViewLibrary.mock.calls[1][2]).toEqual({ strategy: 'merge', dryRun: false, branchId: null })
        expect(onImported).toHaveBeenCalledWith(done)
        expect(useReferenceModelStore.getState().displayRules).toEqual([rule])
    })

    it('says why a file is not a library, and asks the server nothing', async () => {
        renderDialog()
        await chooseFile('{"hello": 1}')
        expect(await screen.findByRole('alert')).toHaveTextContent("This isn't a view library file")
        expect(importViewLibrary).not.toHaveBeenCalled()
    })
})
