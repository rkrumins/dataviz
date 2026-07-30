/**
 * The last line of defence under every lazy route.
 *
 * `<Suspense>` handles a pending dynamic import and nothing else. When
 * one *rejects* — the chunk 404s after a deploy, or the network drops
 * mid-fetch — the rejection propagates as a render error, and with no
 * boundary above it React unmounts the tree. The user gets a blank page
 * and a console message, with no way back except a manual reload they
 * have no reason to know they need.
 *
 * `lazyWithRetry` already retries and, once, reloads. This catches what
 * survives that: a genuinely offline client, or a component that threw
 * for its own reasons after loading fine. Both deserve a page that says
 * so and offers the one action that helps.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
    children: ReactNode
}

interface State {
    error: Error | null
}

/**
 * A rejected dynamic import, as reported by each engine. Matched on the
 * message because there is no error type to check: the browsers throw a
 * plain `TypeError`.
 */
function isChunkLoadError(error: Error): boolean {
    const text = `${error.name}: ${error.message}`
    return (
        /dynamically imported module/i.test(text)
        || /Loading chunk \d+ failed/i.test(text)
        || /Importing a module script failed/i.test(text)
        || /ChunkLoadError/i.test(text)
    )
}

export class RouteErrorBoundary extends Component<Props, State> {
    state: State = { error: null }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // Logged rather than swallowed: a chunk failure that reaches here
        // has already survived retry and reload, so it is worth seeing.
        console.error('[route] render failed', error, info.componentStack)
    }

    private reload = (): void => {
        window.location.reload()
    }

    render(): ReactNode {
        const { error } = this.state
        if (!error) return this.props.children

        const chunk = isChunkLoadError(error)
        return (
            <div className="absolute inset-0 flex items-center justify-center bg-canvas p-6">
                <div className="max-w-md text-center space-y-3">
                    <h1 className="text-lg font-medium text-primary">
                        {chunk ? 'This page could not be loaded' : 'Something went wrong'}
                    </h1>
                    <p className="text-sm text-secondary">
                        {chunk
                            ? 'Part of the application failed to download. This usually '
                              + 'means the connection dropped, or a new version was '
                              + 'released while this tab was open.'
                            : 'The page hit an unexpected error and stopped rendering.'}
                    </p>
                    <button
                        type="button"
                        onClick={this.reload}
                        className="px-4 py-2 rounded-md bg-accent-lineage text-white text-sm"
                    >
                        Reload
                    </button>
                </div>
            </div>
        )
    }
}
