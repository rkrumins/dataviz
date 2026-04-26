import { AlertTriangle, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface SkipAggregationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isSubmitting: boolean;
}

export function SkipAggregationDialog({
  isOpen,
  onClose,
  onConfirm,
  isSubmitting
}: SkipAggregationDialogProps) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="bg-canvas-elevated w-full max-w-md rounded-2xl shadow-xl overflow-hidden"
        >
          <div className="p-6">
            <div className="w-12 h-12 bg-amber-500/10 rounded-full flex items-center justify-center mb-4">
              <AlertTriangle className="w-6 h-6 text-amber-500" />
            </div>
            
            <h3 className="text-lg font-bold text-ink mb-2">Skip Graph Aggregation?</h3>
            
            <div className="text-sm text-ink-muted space-y-3">
              <p>
                By skipping the aggregation process, you will be able to create views immediately.
              </p>
              <p>
                However, <strong>performance on deep graph algorithms may be significantly degraded</strong> until the structural hierarchy edges are fully computed.
              </p>
            </div>
            
            <div className="mt-8 flex items-center justify-end gap-3">
              <button
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 text-sm font-medium text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition-colors"
              >
                Continue Aggregating
              </button>
              <button
                onClick={onConfirm}
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors shadow-md"
              >
                {isSubmitting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Skipping...</>
                ) : (
                  'Yes, Skip Aggregation'
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
