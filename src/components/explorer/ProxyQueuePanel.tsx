import { ProgressBar } from '@/components/ui/ProgressBar';
import { useJobs } from '@/hooks/useJobs';
import type { Asset, JobInfo } from '@/types';

export interface ProxyQueuePanelProps {
  assets: Map<string, Asset>;
  proxyJobIdsByAssetId: Record<string, string>;
}

interface ProxyQueueEntry {
  asset: Asset;
  jobId?: string;
  job?: JobInfo;
}

function getJobProgress(job: JobInfo | undefined): number | null {
  if (!job || job.status.type !== 'running') return null;

  const rawProgress = job.status.progress;
  if (!Number.isFinite(rawProgress)) return null;

  return rawProgress <= 1 ? rawProgress * 100 : rawProgress;
}

function getProxyStatusLabel(entry: ProxyQueueEntry): string {
  const { asset, job } = entry;

  if (job?.status.type === 'queued') return 'Queued';
  if (job?.status.type === 'running') return job.status.message ?? 'Optimizing media';
  if (job?.status.type === 'failed') return 'Optimization failed';
  if (asset.proxyStatus === 'ready') return 'Ready';
  if (asset.proxyStatus === 'failed') return 'Optimization failed';
  if (asset.proxyStatus === 'pending') return 'Preparing media';
  if (asset.proxyStatus === 'generating') return 'Optimizing media';
  return 'Optimizing media';
}

function shouldShowAsset(asset: Asset): boolean {
  if (asset.kind !== 'video') return false;
  return (
    asset.proxyStatus === 'pending' ||
    asset.proxyStatus === 'generating' ||
    asset.proxyStatus === 'failed'
  );
}

export function ProxyQueuePanel({
  assets,
  proxyJobIdsByAssetId,
}: ProxyQueuePanelProps): JSX.Element | null {
  const entries = Array.from(assets.values())
    .filter(shouldShowAsset)
    .map((asset) => {
      const jobId = proxyJobIdsByAssetId[asset.id];
      return {
        asset,
        jobId,
      };
    });

  if (entries.length === 0) {
    return null;
  }

  return <ProxyQueuePanelContent entries={entries} />;
}

function ProxyQueuePanelContent({ entries }: { entries: ProxyQueueEntry[] }): JSX.Element {
  const { jobs } = useJobs({ enablePolling: true, pollingInterval: 2500 });
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const hydratedEntries = entries.map((entry) => ({
    ...entry,
    job: entry.jobId ? jobsById.get(entry.jobId) : undefined,
  }));
  const activeCount = entries.filter(
    ({ asset }) => asset.proxyStatus === 'pending' || asset.proxyStatus === 'generating',
  ).length;

  return (
    <section
      data-testid="proxy-queue-panel"
      className="border-b border-editor-border bg-editor-sidebar px-2 py-2"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-editor-text">Media Optimization</h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-muted">
            {activeCount}/{entries.length} active
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {hydratedEntries.map((entry) => {
          const { asset, jobId, job } = entry;
          const progress = getJobProgress(job);

          return (
            <div
              key={asset.id}
              data-testid={`proxy-queue-row-${asset.id}`}
              className="rounded border border-editor-border bg-surface-active px-2 py-2"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-editor-text" title={asset.name}>
                    {asset.name}
                  </p>
                  <p className="truncate text-[11px] text-text-muted">
                    {getProxyStatusLabel(entry)}
                  </p>
                </div>

                {jobId && <span className="shrink-0 text-[10px] text-text-muted">Background</span>}
              </div>

              {(progress !== null || asset.proxyStatus === 'generating') && (
                <ProgressBar
                  value={progress ?? 0}
                  size="sm"
                  indeterminate={progress === null}
                  className="mt-2"
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
