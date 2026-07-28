import type { ReactNode } from 'react'

export function SectionHeader({
    title, children,
}: {
    title: string
    children: ReactNode
}) {
    return (
        <header className="mb-5">
            <h3 className="text-base font-bold text-ink">{title}</h3>
            <p className="mt-1 text-xs text-ink-muted leading-relaxed max-w-xl">
                {children}
            </p>
        </header>
    )
}
