import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProxyQueuePanel } from './ProxyQueuePanel';
import type { Asset, JobInfo } from '@/types';

const mockJobs = vi.hoisted(() => ({
  jobs: [] as JobInfo[],
}));

vi.mock('@/hooks/useJobs', () => ({
  useJobs: () => ({
    jobs: mockJobs.jobs,
    stats: null,
    isLoading: false,
    error: null,
    submitJob: vi.fn(),
    cancelJob: vi.fn(),
    getJob: vi.fn(),
    refreshJobs: vi.fn(),
    refreshStats: vi.fn(),
  }),
}));

function createVideoAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    kind: 'video',
    name: 'interview.mov',
    uri: '/media/interview.mov',
    hash: 'hash-1',
    fileSize: 100,
    importedAt: '2026-03-16T00:00:00.000Z',
    video: {
      width: 3840,
      height: 2160,
      fps: { num: 30, den: 1 },
      codec: 'h264',
      hasAlpha: false,
    },
    license: {
      source: 'user',
      licenseType: 'royalty_free',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
    ...overrides,
  };
}

describe('ProxyQueuePanel', () => {
  beforeEach(() => {
    mockJobs.jobs = [];
    vi.clearAllMocks();
  });

  it('renders nothing when no video assets need proxy attention', () => {
    const { container } = render(
      <ProxyQueuePanel
        assets={
          new Map([
            ['asset-1', createVideoAsset({ video: { ...createVideoAsset().video!, height: 720 } })],
          ])
        }
        proxyJobIdsByAssetId={{}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps proxy-recommended assets hidden because generation is automatic', () => {
    const { container } = render(
      <ProxyQueuePanel
        assets={new Map([['asset-1', createVideoAsset()]])}
        proxyJobIdsByAssetId={{}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows running job progress as background media optimization', () => {
    mockJobs.jobs = [
      {
        id: 'job-1',
        jobType: 'proxy_generation',
        priority: 'normal',
        status: { type: 'running', progress: 0.42, message: 'Encoding: 42.0%' },
        createdAt: '2026-03-16T00:00:00.000Z',
      },
    ];

    render(
      <ProxyQueuePanel
        assets={new Map([['asset-1', createVideoAsset({ proxyStatus: 'generating' })]])}
        proxyJobIdsByAssetId={{ 'asset-1': 'job-1' }}
      />,
    );

    expect(screen.getByText('Encoding: 42.0%')).toBeInTheDocument();
    expect(screen.getByText('Background')).toBeInTheDocument();
    expect(screen.queryByTestId('proxy-cancel-asset-1')).not.toBeInTheDocument();
  });

  it('keeps ready proxies hidden from the main explorer surface', () => {
    const { container } = render(
      <ProxyQueuePanel
        assets={
          new Map([
            [
              'asset-1',
              createVideoAsset({ proxyStatus: 'ready', proxyUrl: '/proxy/interview.mp4' }),
            ],
          ])
        }
        proxyJobIdsByAssetId={{}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows failed proxy jobs without exposing manual proxy routing controls', () => {
    render(
      <ProxyQueuePanel
        assets={new Map([['asset-1', createVideoAsset({ proxyStatus: 'failed' })]])}
        proxyJobIdsByAssetId={{}}
      />,
    );

    expect(screen.getByTestId('proxy-queue-panel')).toBeInTheDocument();
    expect(screen.getByText('Optimization failed')).toBeInTheDocument();
    expect(screen.queryByTestId('proxy-generate-asset-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proxy-use-original-asset-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proxy-cancel-asset-1')).not.toBeInTheDocument();
  });
});
