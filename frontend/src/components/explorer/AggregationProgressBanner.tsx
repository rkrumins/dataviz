import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { aggregationService, type DataSourceReadinessResponse } from '@/services/aggregationService';
import { SkipAggregationDialog } from './SkipAggregationDialog';

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

  useEffect(() => {
    if (!dataSourceId) return;

    let mounted = true;
    let pollInterval: ReturnType<typeof setTimeout>;

    const checkStatus = async () => {
      try {
        const res = await aggregationService.getReadiness(dataSourceId);
        if (mounted) {
          setReadiness(res);
          onStatusChange(res.isReady);
          if (res.isReady && !res.driftDetected) {
            clearInterval(pollInterval);
          }
        }
      } catch (err) {
        console.error('Failed to check aggregation readiness', err);
      }
    };

    checkStatus();
    pollInterval = setInterval(checkStatus, 5000);

    return () => {
      mounted = false;
      clearInterval(pollInterval);
    };
  }, [dataSourceId, onStatusChange]);

  if (!readiness || readiness.isReady) {
    if (readiness?.driftDetected) {
      return (
        <div className="mb-6 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">Graph Drift Detected</p>
              <p className="text-xs text-amber-600/80 dark:text-amber-400/80">
                The underlying graph structure has changed since the last aggregation. Some lineage relationships may be out of date.
              </p>
            </div>
          </div>
          <button 
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
            onClick={() => {
              if (dataSourceId) {
                aggregationService.triggerAggregation(dataSourceId, { projectionMode: 'in_source', batchSize: 500 }, 'manual');
                setReadiness(prev => prev ? { ...prev, driftDetected: false, aggregationStatus: 'pending' } : null);
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
  const progress = activeJob ? Math.round(activeJob.progress * 100) : 0;
  
  return (
    <div className="mb-6 rounded-xl border border-indigo-500/20 bg-indigo-500/5 overflow-hidden">
      <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center shrink-0">
            {readiness.aggregationStatus === 'failed' ? (
              <AlertCircle className="w-5 h-5 text-red-500" />
            ) : readiness.aggregationStatus === 'ready' || readiness.aggregationStatus === 'skipped' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            ) : (
              <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">
              {readiness.aggregationStatus === 'failed' ? 'Aggregation Failed' : 
               readiness.aggregationStatus === 'running' ? 'Aggregating Graph Lineage...' : 
               readiness.aggregationStatus === 'pending' ? 'Preparing Aggregation...' : 
               'Aggregation Status: ' + readiness.aggregationStatus}
            </h3>
            <p className="text-xs text-ink-muted mt-0.5 max-w-xl">
              {readiness.aggregationStatus === 'failed' ? (
                activeJob?.errorMessage || 'An unknown error occurred during aggregation.'
              ) : (
                'We are pre-computing structural hierarchies to optimize deep graph queries. View creation is paused until this completes.'
              )}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
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
