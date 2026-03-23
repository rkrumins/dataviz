export function SkeletonCards() {
  return (
    <div className="max-w-6xl mx-auto p-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-black/5 dark:bg-white/10 animate-pulse" />
          <div className="space-y-2">
            <div className="h-8 w-32 bg-black/5 dark:bg-white/10 rounded-lg animate-pulse" />
            <div className="h-4 w-64 bg-black/5 dark:bg-white/10 rounded animate-pulse" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-glass-border bg-canvas-elevated p-6 overflow-hidden"
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="w-9 h-9 rounded-lg bg-black/5 dark:bg-white/10 animate-pulse" />
              <div className="h-5 w-24 bg-black/5 dark:bg-white/10 rounded animate-pulse" />
            </div>
            <div className="space-y-4">
              {[1, 2].map((j) => (
                <div key={j} className="space-y-2">
                  <div className="h-4 w-3/4 bg-black/5 dark:bg-white/10 rounded animate-pulse" />
                  <div className="h-3 w-full bg-black/5 dark:bg-white/10 rounded animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
