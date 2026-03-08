/**
 * 404 page for unmatched routes.
 */
import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <div className="text-7xl font-bold text-ink-faint">404</div>
        <h2 className="text-xl font-semibold text-ink-primary">Page not found</h2>
        <p className="text-sm text-ink-secondary">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          to="/dashboard"
          className="text-sm text-accent-lineage hover:underline"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  )
}
