/**
 * Loading placeholder for a doc / guide article — mirrors the real layout
 * (breadcrumb, meta chip, title, prose, a callout block) so the swap to real
 * content doesn't jump.
 */
export function ContentSkeleton() {
  const bar = 'rounded bg-black/5 dark:bg-white/5'
  return (
    <div className="mx-auto max-w-4xl px-8 py-10" aria-hidden>
      <div className="animate-pulse">
        <div className={`h-4 w-48 ${bar} mb-6`} />
        <div className={`h-6 w-28 rounded-full bg-black/5 dark:bg-white/5 mb-5`} />
        <div className={`h-9 w-3/4 ${bar} mb-6`} />
        <div className="space-y-3">
          <div className={`h-4 w-full ${bar}`} />
          <div className={`h-4 w-11/12 ${bar}`} />
          <div className={`h-4 w-4/6 ${bar}`} />
          <div className={`mt-6 h-20 w-full rounded-xl bg-black/5 dark:bg-white/5`} />
          <div className={`mt-6 h-4 w-full ${bar}`} />
          <div className={`h-4 w-5/6 ${bar}`} />
          <div className={`h-4 w-3/4 ${bar}`} />
        </div>
      </div>
    </div>
  )
}
