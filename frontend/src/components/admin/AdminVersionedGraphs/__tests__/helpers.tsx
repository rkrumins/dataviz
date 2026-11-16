/**
 * The section's tests run the real pages, hooks and service against the harness's in-memory API
 * (`harness/versionedGraphsFixtures.ts`), through a stubbed `fetch`: every request is recorded,
 * and a test can answer any route its own way first.
 */
import { configure, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { NotificationStack } from '@/components/ui/notifications'
import { versionedGraphsFetch, type Scenario } from '@/harness/versionedGraphsFixtures'
import { Where } from './Where'

// A settings page draws 46 rich rows on its first answer; with the whole suite running in parallel
// that can take longer than the 1 s `findBy*` waits by default.
configure({ asyncUtilTimeout: 5000 })

export interface Sent {
    method: string
    path: string
    query: URLSearchParams
    body: unknown
    headers: Headers
}

type Answer = Response | Promise<Response> | undefined

export const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Stub `fetch` with the harness's API for `scenario`; `answer` sees each request first and may
 * answer it (return undefined to let the harness). Returns the requests sent, in order.
 */
export function mockApi(scenario: Scenario = 'ok', answer: (req: Sent) => Answer = () => undefined): Sent[] {
    const harness = versionedGraphsFetch(scenario)
    const sent: Sent[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
        const req: Sent = {
            method: (init?.method ?? 'GET').toUpperCase(),
            path: url.pathname,
            query: url.searchParams,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            headers: new Headers(init?.headers),
        }
        sent.push(req)
        return (await answer(req)) ?? harness(url.pathname + url.search, init)
    }))
    return sent
}

/** The requests to a path, by method. */
export const calls = (sent: Sent[], method: string, pathEnd: string) => sent.filter((r) => r.method === method && r.path.endsWith(pathEnd))

export function renderWithApi(ui: ReactNode, { path = '/admin/versioned-graphs', route = '/admin/versioned-graphs' } = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path={route} element={<>{ui}<Where /></>} />
                    <Route path="*" element={<Where />} />
                </Routes>
            </MemoryRouter>
            <NotificationStack />
        </QueryClientProvider>,
    )
}

/** jsdom lays nothing out: draw every row of a virtual list. */
export const virtualizerMock = () => ({
    useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
        getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
            index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 100, size: 100,
        })),
        getTotalSize: () => opts.count * 100,
        measureElement: () => undefined,
    }),
})

/** jsdom lacks the pointer-capture APIs Radix menus call when they open. */
export function allowMenus() {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false)
    Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
}
