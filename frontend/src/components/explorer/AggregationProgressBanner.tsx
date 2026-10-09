import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { aggregationService, type DataSourceReadinessResponse } from '@/services/aggregationService';
import { DEFAULT_TIMEOUT_SECS, gentlePreset } from '@/components/admin/shared/AggregationOverridesForm';
import { friendlyError } from '@/services/providerService';
import { extendStallPatch } from '@/components/admin/job-history/timeLimits';
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage';
import { SkipAggregationDialog } from './SkipAggregationDialog';

/**
 * Statuses no amount of polling will change.
 *
 * `none` means aggregation was never configured; `skipped` and `cancelled`
 * mean a person decided; `failed` stays failed until someone acts. The Skip
 * and Re-aggregate buttons below set their own state and bump `pollEpoch`, so
 * the poll restarts when something actually starts.
 */
const TERMINAL_STATUSES = new Set(['none', 'skipped', 'cancelled', 'failed']);

const IN_PROGRESS_BODY =
  'We are pre-computing structural hierarchies to optimize deep graph queries. View creation is paused until this completes.';

const HEADINGS: Record<string, string> = {
  failed: 'Aggregation Failed',
  running: 'Aggregating Graph Lineage...',
  pending: 'Preparing Aggregation...',
  none: 'Aggregation Not Set Up',
  skipped: 'Aggregation Skipped',
  cancelled: 'Aggregation Cancelled',
};

/**
 * What each settled state actually means. The spinner copy — "we are
 * pre-computing … view creation is paused until this completes" — used to be
 * shown for ALL of these, so a source somebody had deliberately skipped
 * claimed work was in flight and views were blocked. Both halves were false,
 * and neither would ever have resolved.
 */
const BODIES: Record<string, string> = {
  none: 'Aggregation has not been set up for this source. Views can still be created; rolled-up connections will not appear until it runs.',
  skipped: 'Aggregation was skipped for this source. Views work as normal — rolled-up connections between items just will not appear. Re-aggregate below to compute them.',
  cancelled: 'The last aggregation run was cancelled, so rolled-up connections may be missing or out of date. Nothing is running now.',
};

export function AggregationProgressBanner({
  dataSourceId,
  onStatusChange
}: {
  workspaceId: string;
  dataSourceId: string | undefined;
  onStatusChange: (isReady: boolean) => void;
}) {
  const [readiness, setReadiness] = useState<DataSourceReadinessResponse | null>(null);
  const [isSkipping, setIsSkipping] = useState(false);
  const [showSkipDialog, setShowSkipDialog] = useState(false);
  // Bumped by the Re-aggregate button to restart polling for the new job.
  const [pollEpoch, setPollEpoch] = useState(0);

  useEffect(() => {
    if (!dataSourceId) return;

    let mounted = true;
    let pollInterval: ReturnType<typeof setInterval>;
    let consecutiveErrors = 0;

    const checkStatus = async () => {
      try {
        const res = await aggregationService.getReadiness(dataSourceId);
        consecutiveErrors = 0;
        if (mounted) {
          setReadiness((prev) => {
            // An aggregation job finishing changes which rollups the server
            // reports, but the canvas's visible set (its cache key) doesn't
            // change — without this bump the 5-min aggregated-edge cache
            // keeps serving the pre-run (often empty) answers.
            if (prev && !prev.isReady && res.isReady) invalidateAggregatedEdges();
            return res;
          });
          onStatusChange(res.isReady);
          // Terminal states — polling can't change them. `isReady` is only
          // `status === 'ready'`, so it covers exactly one of them: `none`,
          // `skipped`, `cancelled` and `failed` are every bit as settled, and
          // without them listed here the 5s poll ran forever — on an end-user
          // surface, from backgrounded tabs, for a source somebody had just
          // explicitly skipped.
          if (res.isReady || TERMINAL_STATUSES.has(res.aggregationStatus)) {
            clearInterval(pollInterval);
          }
        }
      } catch (err) {
        console.error('Failed to check aggregation readiness', err);
        // Backend unreachable — stop hammering it; a remount or the
        // Re-aggregate button (pollEpoch bump) resumes polling.
        if (++consecutiveErrors >= 3) clearInterval(pollInterval);
      }
    };

    checkStatus();
    pollInterval = setInterval(checkStatus, 5000);

    return () => {
      mounted = false;
      clearInterval(pollInterval);
    };
  }, [dataSourceId, onStatusChange, pollEpoch]);

  if (!readiness || readiness.isReady) {
    if (readiness?.driftDetected) {
      // Why this banner is still here. Drift is terminal for the poll above —
      // it clears when something rebuilds the source, and while a hold is in
      // force nothing automatic will. Saying so turns "this warning never goes
      // away" into two things the reader can act on: the button below still
      // works, and someone can lift the hold.
      const heldWhere = readiness.heldBy === 'fleet' ? 'for every source'
        : readiness.heldBy === 'provider' ? 'for this provider'
          : readiness.heldBy === 'source' ? 'for this source' : null
      return (
        <div className="mb-6 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">Graph Drift Detected</p>
              <p className="text-xs text-amber-600/80 dark:text-amber-400/80">
                The underlying graph structure has changed since the last aggregation. Some lineage relationships may be out of date.
              </p>
              {heldWhere && (
                <p className="mt-1 text-xs text-amber-600/80 dark:text-amber-400/80">
                  Automatic rebuilds are {readiness.heldKind === 'paused' ? 'paused' : 'off'} {heldWhere},
                  so this will not rebuild on its own. Re-aggregate still works, or an admin can
                  resume automation under Ingestion → Automation.
                </p>
              )}
            </div>
          </div>
          <button 
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
            onClick={() => {
              if (dataSourceId) {
                // No ``tuning``: the control plane resolves the admin's
                // configured defaults. ``timeoutSecs`` is sent because a
                // null column falls back to the 15-minute stall window.
                aggregationService.triggerAggregation(dataSourceId, { projectionMode: 'in_source', batchSize: 500, timeoutSecs: DEFAULT_TIMEOUT_SECS }, 'manual');
                setReadiness(prev => prev ? { ...prev, driftDetected: false, aggregationStatus: 'pending' } : null);
                setPollEpoch(e => e + 1);
              }
            }}
          >
            Re-aggregate
          </button>
        </div>
      );
    }
    return null;
  }

  const { activeJob } = readiness;
  // Backend progress is already a 0-100 percentage.
  const progress = activeJob ? Math.round(activeJob.progress) : 0;
  
  return (
    <div className="mb-6 rounded-xl border border-indigo-500/20 bg-indigo-500/5 overflow-hidden">
      <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center shrink-0">
            {readiness.aggregationStatus === 'failed' ? (
              <AlertCircle className="w-5 h-5 text-red-500" />
            ) : readiness.aggregationStatus === 'ready' || readiness.aggregationStatus === 'skipped' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            ) : TERMINAL_STATUSES.has(readiness.aggregationStatus) ? (
              // Settled, not working. A spinner here said something was in
              // flight for a source where nothing was, and never stopped.
              <AlertCircle className="w-5 h-5 text-amber-500" />
            ) : (
              <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">
              {HEADINGS[readiness.aggregationStatus] ?? ('Aggregation Status: ' + readiness.aggregationStatus)}
            </h3>
            <p className="text-xs text-ink-muted mt-0.5 max-w-xl">
              {readiness.aggregationStatus === 'failed'
                ? (activeJob?.errorMessage ? friendlyError(activeJob.errorMessage) : 'An unknown error occurred during aggregation.')
                : (BODIES[readiness.aggregationStatus] ?? IN_PROGRESS_BODY)}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {readiness.aggregationStatus === 'running' && activeJob && dataSourceId && (
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-indigo-500/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors"
              title="Raise this job's stall window by three hours without cancelling it"
              onClick={() => {
                aggregationService.setJobLimits(dataSourceId, activeJob.id, extendStallPatch(activeJob, 3)).catch(() => {});
              }}
            >
              Give it more time (+3 h)
            </button>
          )}
          {readiness.aggregationStatus === 'running' && (
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs font-semibold text-indigo-500">{progress}%</span>
              <div className="w-32 h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                <div 
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
          
          {readiness.aggregationStatus === 'failed' && dataSourceId
            && (activeJob?.failureCategory === 'query_memory' || activeJob?.failureCategory === 'timeout') && (
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 transition-colors"
              title="Narrow scans, serial reads, generous pacing and a longer per-query timeout — the profile for a graph the store keeps refusing"
              onClick={() => {
                const gentle = gentlePreset();
                aggregationService.triggerAggregation(dataSourceId, {
                  projectionMode: 'in_source', batchSize: 500,
                  maxRetries: gentle.maxRetries, timeoutSecs: gentle.timeoutMinutes * 60, tuning: gentle.tuning,
                }, 'manual');
                setReadiness(prev => prev ? { ...prev, aggregationStatus: 'pending' } : null);
                setPollEpoch(e => e + 1);
              }}
            >
              Retry with the Gentle profile
            </button>
          )}
          <button
            onClick={() => setShowSkipDialog(true)}
            className="text-xs text-ink-muted hover:text-ink underline underline-offset-2 transition-colors ml-2"
          >
            Skip for now
          </button>
        </div>
      </div>
      
      {showSkipDialog && dataSourceId && (
        <SkipAggregationDialog 
          isOpen={showSkipDialog}
          onClose={() => setShowSkipDialog(false)}
          onConfirm={async () => {
            setIsSkipping(true);
            try {
              if (activeJob) {
                await aggregationService.cancelJob(dataSourceId, activeJob.id);
              }
              const result = await aggregationService.skipAggregation(dataSourceId);
              setReadiness(result);
              onStatusChange(result.isReady);
            } catch (err) {
              console.error('Failed to skip aggregation', err);
            } finally {
              setIsSkipping(false);
              setShowSkipDialog(false);
            }
          }}
          isSubmitting={isSkipping}
        />
      )}
    </div>
  );
}
