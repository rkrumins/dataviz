/**
 * Polished access-denied notice. Replaces every place the FE used to
 * dump raw JSON / Error.message when a 403 (or other failure) came
 * back from the backend.
 *
 * Pass any error shape (Error, string, structured payload) — the
 * underlying ``parsePermissionError`` helper extracts the permission +
 * scope automatically when the error is a backend permission denial.
 * Non-permission errors fall back to a styled "Something went wrong"
 * card so the same component covers every failure surface.
 *
 * Variants:
 *   * ``card``    — centered hero card; use as the empty state for a
 *                   whole section that can't load.
 *   * ``inline``  — left-aligned banner; sits inside a form / dialog.
 *   * ``compact`` — slim single-line notice; replaces the small red
 *                   pills that used to render under inputs.
 *
 * Visual language mirrors the existing ``RequirePermission`` DeniedPanel
 * and ``AccessDeniedModal`` notification: amber/500 gradient icon box for
 * permission denials, red/500 for unexpected errors. Same family of
 * monospace permission chips as the rest of the admin shell.
 */
import { useState, type ReactNode } from 'react'
import {
    ShieldOff,
    AlertTriangle,
    ChevronDown,
    Lock,
    RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    parsePermissionError,
    humanizeErrorMessage,
    type ParsedPermissionError,
} from '@/lib/permissionError'
import { DocsLink } from '@/components/help/DocsLink'


export type AccessDeniedVariant = 'card' | 'inline' | 'compact'

interface AccessDeniedNoticeProps {
    /** Any error: Error, string, or a structured detail object. */
    error: unknown
    variant?: AccessDeniedVariant
    /** What the user was trying to do, e.g. "view providers". Shown
     *  in the body so the message reads naturally. Optional — falls
     *  back to a generic phrasing. */
    feature?: string
    /** Override the heading when the default ("You don't have access")
     *  doesn't fit the surface. */
    title?: string
    /** Force the non-permission "something went wrong" treatment even
     *  when the error parses as a permission denial. Rare. */
    forceGenericError?: boolean
    /** Optional retry callback — renders a small Retry button. Useful
     *  for transient network failures. */
    onRetry?: () => void
    /** Inline node rendered next to the message (e.g. a "Request
     *  access" link). */
    action?: ReactNode
    className?: string
}


export function AccessDeniedNotice({
    error,
    variant = 'card',
    feature,
    title,
    forceGenericError,
    onRetry,
    action,
    className,
}: AccessDeniedNoticeProps) {
    const parsed = forceGenericError ? null : parsePermissionError(error)
    if (parsed) {
        return (
            <PermissionDeniedView
                parsed={parsed}
                variant={variant}
                feature={feature}
                title={title}
                action={action}
                className={className}
            />
        )
    }
    return (
        <GenericErrorView
            message={humanizeErrorMessage(error)}
            variant={variant}
            title={title}
            onRetry={onRetry}
            action={action}
            className={className}
        />
    )
}


// ── Permission-denied treatment ─────────────────────────────────────

interface PermissionDeniedViewProps {
    parsed: ParsedPermissionError
    variant: AccessDeniedVariant
    feature?: string
    title?: string
    action?: ReactNode
    className?: string
}


function PermissionDeniedView({
    parsed,
    variant,
    feature,
    title,
    action,
    className,
}: PermissionDeniedViewProps) {
    const [showDetails, setShowDetails] = useState(false)

    const heading =
        title ??
        (variant === 'card'
            ? "You don't have access to this"
            : 'Access required')

    // Render a clean sentence rather than echoing the raw backend
    // ``message``. ``feature`` lets the caller localise the verb
    // ("view providers", "edit catalog items", "manage admission control").
    const body = feature ? (
        <>
            You don't have permission to {feature}. Ask a workspace or
            platform administrator if you need access.
        </>
    ) : (
        <>
            Your role doesn't include the permission needed for this. Ask
            a workspace or platform administrator if you should.
        </>
    )

    if (variant === 'compact') {
        return (
            <div
                className={cn(
                    'flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20',
                    className,
                )}
                role="status"
            >
                <ShieldOff className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-700 dark:text-amber-300 leading-snug">
                    <span className="font-semibold">{heading}.</span>{' '}
                    <span className="text-amber-700/80 dark:text-amber-300/80">
                        Requires{' '}
                    </span>
                    <PermChip perm={parsed.permission} tone="amber" />
                    {action ? <span className="ml-2">{action}</span> : null}
                </div>
            </div>
        )
    }

    if (variant === 'inline') {
        return (
            <div
                className={cn(
                    'rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4',
                    className,
                )}
                role="status"
            >
                <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg border border-amber-500/25 bg-gradient-to-br from-amber-500/20 to-amber-500/0 flex items-center justify-center shrink-0">
                        <Lock className="w-4 h-4 text-amber-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink">{heading}</p>
                        <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
                            {body}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-[11px] uppercase tracking-wider font-bold text-ink-muted">
                                Required
                            </span>
                            <PermChip perm={parsed.permission} tone="amber" />
                            {parsed.scope?.type === 'workspace' && parsed.scope.id && (
                                <>
                                    <span className="text-[11px] text-ink-muted">in</span>
                                    <PermChip
                                        perm={parsed.scope.id}
                                        tone="slate"
                                    />
                                </>
                            )}
                            {action}
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    // ── Card (default) ──────────────────────────────────────────────
    return (
        <div
            className={cn(
                'flex items-center justify-center min-h-[40vh] p-8',
                className,
            )}
            role="status"
        >
            <div className="max-w-md text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500/20 to-amber-500/0 border border-amber-500/25 flex items-center justify-center mx-auto mb-5 shadow-sm shadow-amber-500/10">
                    <ShieldOff className="w-7 h-7 text-amber-500" />
                </div>
                <h2 className="text-base font-bold text-ink mb-1.5">{heading}</h2>
                <p className="text-sm text-ink-muted leading-relaxed">{body}</p>
                <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                    <span className="text-[11px] uppercase tracking-wider font-bold text-ink-muted">
                        Required
                    </span>
                    <PermChip perm={parsed.permission} tone="amber" />
                    {parsed.scope?.type === 'workspace' && parsed.scope.id && (
                        <>
                            <span className="text-[11px] text-ink-muted">in</span>
                            <PermChip perm={parsed.scope.id} tone="slate" />
                        </>
                    )}
                </div>
                <div className="mt-4">
                    {action ?? (
                        <DocsLink
                            slug="users-access"
                            variant="inline"
                            label="Learn about roles & access"
                        />
                    )}
                </div>
                <button
                    onClick={() => setShowDetails((v) => !v)}
                    className="mt-4 inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink-secondary transition-colors"
                    type="button"
                >
                    <ChevronDown
                        className={cn(
                            'w-3 h-3 transition-transform',
                            showDetails && 'rotate-180',
                        )}
                    />
                    Technical details
                </button>
                {showDetails && (
                    <div className="mt-2 text-left text-[11px] font-mono text-ink-muted bg-glass-base/40 border border-glass-border rounded-lg p-2.5 space-y-0.5">
                        <div>
                            <span className="text-ink-muted/60">code: </span>
                            {parsed.code}
                        </div>
                        <div>
                            <span className="text-ink-muted/60">permission: </span>
                            {parsed.permission}
                        </div>
                        <div>
                            <span className="text-ink-muted/60">scope: </span>
                            {parsed.scope
                                ? `${parsed.scope.type}${parsed.scope.id ? ':' + parsed.scope.id : ''}`
                                : 'global'}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}


// ── Generic error treatment (non-permission) ───────────────────────

interface GenericErrorViewProps {
    message: string
    variant: AccessDeniedVariant
    title?: string
    onRetry?: () => void
    action?: ReactNode
    className?: string
}


function GenericErrorView({
    message,
    variant,
    title,
    onRetry,
    action,
    className,
}: GenericErrorViewProps) {
    const heading = title ?? 'Something went wrong'

    if (variant === 'compact') {
        return (
            <div
                className={cn(
                    'flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20',
                    className,
                )}
                role="alert"
            >
                <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                <div className="text-xs text-red-700 dark:text-red-300 leading-snug min-w-0 flex-1">
                    <span className="font-semibold">{heading}.</span>{' '}
                    <span className="opacity-90 break-words">{message}</span>
                </div>
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className="ml-2 inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 dark:text-red-300 hover:underline shrink-0"
                        type="button"
                    >
                        <RefreshCw className="w-3 h-3" /> Retry
                    </button>
                )}
            </div>
        )
    }

    if (variant === 'inline') {
        return (
            <div
                className={cn(
                    'rounded-xl border border-red-500/25 bg-red-500/[0.05] p-4',
                    className,
                )}
                role="alert"
            >
                <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg border border-red-500/25 bg-gradient-to-br from-red-500/15 to-red-500/0 flex items-center justify-center shrink-0">
                        <AlertTriangle className="w-4 h-4 text-red-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink">{heading}</p>
                        <p className="text-xs text-ink-muted mt-0.5 leading-relaxed break-words">
                            {message}
                        </p>
                        {(onRetry || action) && (
                            <div className="mt-2 flex items-center gap-3">
                                {onRetry && (
                                    <button
                                        onClick={onRetry}
                                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:underline"
                                        type="button"
                                    >
                                        <RefreshCw className="w-3 h-3" /> Try again
                                    </button>
                                )}
                                {action}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div
            className={cn(
                'flex items-center justify-center min-h-[40vh] p-8',
                className,
            )}
            role="alert"
        >
            <div className="max-w-md text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-red-500/15 to-red-500/0 border border-red-500/25 flex items-center justify-center mx-auto mb-5 shadow-sm shadow-red-500/10">
                    <AlertTriangle className="w-7 h-7 text-red-500" />
                </div>
                <h2 className="text-base font-bold text-ink mb-1.5">{heading}</h2>
                <p className="text-sm text-ink-muted leading-relaxed break-words">
                    {message}
                </p>
                {(onRetry || action) && (
                    <div className="mt-4 flex items-center justify-center gap-3">
                        {onRetry && (
                            <button
                                onClick={onRetry}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/25 hover:bg-red-500/15 transition-colors"
                                type="button"
                            >
                                <RefreshCw className="w-3.5 h-3.5" /> Try again
                            </button>
                        )}
                        {action}
                    </div>
                )}
            </div>
        </div>
    )
}


// ── Building blocks ────────────────────────────────────────────────

function PermChip({
    perm,
    tone,
}: {
    perm: string
    tone: 'amber' | 'slate'
}) {
    return (
        <code
            className={cn(
                'font-mono text-[11px] px-1.5 py-0.5 rounded border',
                tone === 'amber'
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-200 border-amber-500/25'
                    : 'bg-glass-base/40 text-ink-secondary border-glass-border',
            )}
        >
            {perm}
        </code>
    )
}
