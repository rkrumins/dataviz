import { useNavigate } from 'react-router-dom'
import {
  Layers, Database, Server, BarChart3,
  ArrowRight, CheckCircle2, ShieldAlert, Zap
} from 'lucide-react'
import { cn } from '@/lib/utils'

export function AdminDataSourcesOverview() {
  const navigate = useNavigate()

  return (
    <div className="max-w-5xl mx-auto p-8 animate-in fade-in duration-500">
      <div className="mb-10">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Layers className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink">Enterprise Data Catalog</h1>
            <p className="text-sm text-ink-muted mt-1">
              Manage your graph database connections, workspace subscriptions, and view lineage analytics across the organization.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        {/* Workspaces Card */}
        <div 
          onClick={() => navigate('/admin/workspaces')}
          className="group relative bg-canvas-elevated rounded-2xl border border-glass-border p-6 hover:shadow-xl hover:border-indigo-500/30 transition-all duration-300 cursor-pointer overflow-hidden"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-transparent to-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="relative">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <Database className="w-5 h-5 text-blue-500" />
            </div>
            <h2 className="text-lg font-bold text-ink mb-2">Workspaces</h2>
            <p className="text-sm text-ink-secondary mb-4 min-h-[60px]">
              Sandboxed environments for teams. Subscribe to specific Data Sources and manage localized logic without affecting the core catalog.
            </p>
            <div className="flex items-center text-xs font-semibold text-blue-500 group-hover:translate-x-1 transition-transform">
              Manage Workspaces <ArrowRight className="w-4 h-4 ml-1" />
            </div>
          </div>
        </div>

        {/* Providers Card */}
        <div 
          onClick={() => navigate('/admin/providers')}
          className="group relative bg-canvas-elevated rounded-2xl border border-glass-border p-6 hover:shadow-xl hover:border-emerald-500/30 transition-all duration-300 cursor-pointer overflow-hidden"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-transparent to-emerald-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="relative">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <Server className="w-5 h-5 text-emerald-500" />
            </div>
            <h2 className="text-lg font-bold text-ink mb-2">Providers</h2>
            <p className="text-sm text-ink-secondary mb-4 min-h-[60px]">
              Physical database connections (e.g. FalkorDB clusters). Register and monitor the health of your enterprise graph infrastructure.
            </p>
            <div className="flex items-center text-xs font-semibold text-emerald-500 group-hover:translate-x-1 transition-transform">
              Manage Providers <ArrowRight className="w-4 h-4 ml-1" />
            </div>
          </div>
        </div>

        {/* Insights Card */}
        <div 
          onClick={() => navigate('/admin/insights')}
          className="group relative bg-canvas-elevated rounded-2xl border border-glass-border p-6 hover:shadow-xl hover:border-amber-500/30 transition-all duration-300 cursor-pointer overflow-hidden"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-transparent to-amber-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="relative">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <BarChart3 className="w-5 h-5 text-amber-500" />
            </div>
            <h2 className="text-lg font-bold text-ink mb-2">Insights</h2>
            <p className="text-sm text-ink-secondary mb-4 min-h-[60px]">
              Cross-workspace analytics. View ingestion metrics, query performance, and graph size evolution across your entire catalog.
            </p>
            <div className="flex items-center text-xs font-semibold text-amber-500 group-hover:translate-x-1 transition-transform">
              View Insights <ArrowRight className="w-4 h-4 ml-1" />
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-br from-black/5 to-transparent dark:from-white/5 dark:to-transparent rounded-2xl border border-glass-border p-8">
        <h3 className="text-base font-bold text-ink mb-6 flex items-center gap-2">
          <Zap className="w-5 h-5 text-amber-500" />
          Architecture & Governance
        </h3>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 text-sm">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-ink">Multi-Tenant Subscriptions</p>
              <p className="text-ink-secondary mt-1">Data Sources are connected globally and then "clipped" into specific Workspaces, allowing true multi-tenant sharing of graph data.</p>
            </div>
          </div>
          
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-ink">Dedicated Lineage Graphs</p>
              <p className="text-ink-secondary mt-1">Build views on top of Read-Only production graphs without affecting them. All custom schema augmentations are stored in a dedicated sandbox.</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-ink">Strict Isolation</p>
              <p className="text-ink-secondary mt-1">Queries are partitioned and routed physically based on the Workspace Context, preventing accidental cross-talk between isolated sandboxes.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
