/**
 * DeveloperSettings Tests
 *
 * Integration tests for the trace viewer panel.
 * Mocks only the Tauri IPC boundary (external dependency).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeveloperSettings } from './DeveloperSettings';
import type { AgentTrace } from '@/agents/engine/core/traceRecorder';

// Mock the Tauri IPC boundary (external dependency per mock policy)
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// =============================================================================
// Test Fixtures
// =============================================================================

function createTrace(overrides: Partial<AgentTrace> = {}): AgentTrace {
  return {
    traceId: 'trace_test_001',
    sessionId: 'session_001',
    input: 'split clip at 5 seconds',
    phases: [
      {
        phase: 'thinking',
        startTime: 1000,
        endTime: 1200,
        durationMs: 200,
        toolCalls: [],
      },
      {
        phase: 'planning',
        startTime: 1200,
        endTime: 1400,
        durationMs: 200,
        toolCalls: [],
      },
      {
        phase: 'executing',
        startTime: 1400,
        endTime: 1500,
        durationMs: 100,
        toolCalls: [{ name: 'split_clip_at_time', success: true, durationMs: 42 }],
      },
      {
        phase: 'observing',
        startTime: 1500,
        endTime: 1600,
        durationMs: 100,
        toolCalls: [],
      },
    ],
    totalDurationMs: 600,
    tokenUsage: { inputTokens: 2500, outputTokens: 850, totalTokens: 3350 },
    model: 'claude-sonnet-4-5-20251015',
    provider: 'anthropic',
    fastPath: false,
    iterations: 1,
    success: true,
    createdAt: '2026-03-07T12:00:00.000Z',
    ...overrides,
  };
}

const SUMMARY_FIXTURE = [
  {
    traceId: 'trace_test_001',
    fileName: 'trace_test_001.json',
    sizeBytes: 512,
    modifiedAt: '2026-03-07T12:00:00Z',
  },
];

// =============================================================================
// Tests
// =============================================================================

describe('DeveloperSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show empty state when no traces exist', async () => {
    mockInvoke.mockResolvedValue([]);

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/no agent traces recorded/i)).toBeInTheDocument();
    });
  });

  it('should display trace list when traces are loaded', async () => {
    const trace = createTrace();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(SUMMARY_FIXTURE);
      if (cmd === 'read_agent_trace') return Promise.resolve(JSON.stringify(trace));
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/split clip at 5 seconds/i)).toBeInTheDocument();
    });

    expect(screen.getAllByText('Success').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/3.4k/).length).toBeGreaterThan(0);
  });

  it('should request trace details using camelCase binding fields', async () => {
    const trace = createTrace();
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(SUMMARY_FIXTURE);
      if (cmd === 'read_agent_trace') {
        expect(args).toEqual({ traceId: 'trace_test_001' });
        return Promise.resolve(JSON.stringify(trace));
      }
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/split clip at 5 seconds/i)).toBeInTheDocument();
    });
  });

  it('should show trace detail view when a trace is clicked', async () => {
    const trace = createTrace();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(SUMMARY_FIXTURE);
      if (cmd === 'read_agent_trace') return Promise.resolve(JSON.stringify(trace));
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/split clip at 5 seconds/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/split clip at 5 seconds/i));

    await waitFor(() => {
      expect(screen.getByText(/phase timeline/i)).toBeInTheDocument();
      expect(screen.getByText(/token usage/i)).toBeInTheDocument();
      expect(screen.getByText(/tool calls/i)).toBeInTheDocument();
      expect(screen.getByText('split_clip_at_time')).toBeInTheDocument();
    });
  });

  it('should navigate back from detail view to list', async () => {
    const trace = createTrace();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(SUMMARY_FIXTURE);
      if (cmd === 'read_agent_trace') return Promise.resolve(JSON.stringify(trace));
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/split clip at 5 seconds/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/split clip at 5 seconds/i));

    await waitFor(() => {
      expect(screen.getByText(/back to list/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/back to list/i));

    await waitFor(() => {
      expect(screen.getByText(/agent execution traces/i)).toBeInTheDocument();
    });
  });

  it('should filter traces by success status', async () => {
    const successTrace = createTrace({ traceId: 'trace_success', input: 'successful edit' });
    const failedTrace = createTrace({
      traceId: 'trace_failed',
      input: 'failed edit',
      success: false,
      error: 'Tool execution failed',
    });

    const summaries = [
      {
        traceId: 'trace_success',
        fileName: 'trace_success.json',
        sizeBytes: 512,
        modifiedAt: '2026-03-07T12:00:00Z',
      },
      {
        traceId: 'trace_failed',
        fileName: 'trace_failed.json',
        sizeBytes: 512,
        modifiedAt: '2026-03-07T11:00:00Z',
      },
    ];

    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(summaries);
      if (cmd === 'read_agent_trace') {
        const id = args?.traceId as string;
        if (id === 'trace_success') return Promise.resolve(JSON.stringify(successTrace));
        if (id === 'trace_failed') return Promise.resolve(JSON.stringify(failedTrace));
      }
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/successful edit/i)).toBeInTheDocument();
      expect(screen.getByText(/failed edit/i)).toBeInTheDocument();
    });

    // Filter to failed only
    const statusSelect = screen.getByLabelText(/status filter/i);
    fireEvent.change(statusSelect, { target: { value: 'failed' } });

    expect(screen.queryByText(/successful edit/i)).not.toBeInTheDocument();
    expect(screen.getByText(/failed edit/i)).toBeInTheDocument();
  });

  it('should show failed badge for failed traces', async () => {
    const failedTrace = createTrace({ success: false, error: 'Clip not found' });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(SUMMARY_FIXTURE);
      if (cmd === 'read_agent_trace') return Promise.resolve(JSON.stringify(failedTrace));
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });
  });

  it('should show tool call details in detail view', async () => {
    const trace = createTrace({
      phases: [
        {
          phase: 'executing',
          startTime: 1000,
          endTime: 2000,
          durationMs: 1000,
          toolCalls: [
            { name: 'insert_clip', success: true, durationMs: 50 },
            { name: 'trim_clip', success: true, durationMs: 30 },
            { name: 'move_clip', success: false, durationMs: 20, error: 'Overlap detected' },
          ],
        },
      ],
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(SUMMARY_FIXTURE);
      if (cmd === 'read_agent_trace') return Promise.resolve(JSON.stringify(trace));
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/split clip at 5 seconds/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/split clip at 5 seconds/i));

    await waitFor(() => {
      expect(screen.getByText('insert_clip')).toBeInTheDocument();
      expect(screen.getByText('trim_clip')).toBeInTheDocument();
      expect(screen.getByText('move_clip')).toBeInTheDocument();
      expect(screen.getByText('ERR')).toBeInTheDocument();
    });
  });

  it('should handle IPC errors gracefully with empty state', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC not available'));

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/no agent traces recorded/i)).toBeInTheDocument();
    });
  });

  it('should show metrics summary panel when traces exist', async () => {
    const trace = createTrace();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(SUMMARY_FIXTURE);
      if (cmd === 'read_agent_trace') return Promise.resolve(JSON.stringify(trace));
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText('Runs')).toBeInTheDocument();
      expect(screen.getByText('Avg Time')).toBeInTheDocument();
      expect(screen.getByText('Tokens')).toBeInTheDocument();
    });

    // Should show 100% success rate (metrics panel + top tools may both show it)
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
    // Should show the tool in top tools
    expect(screen.getByText('split_clip_at_time')).toBeInTheDocument();
    expect(screen.getByText('1x')).toBeInTheDocument();
  });

  it('should show slow run warning in metrics when runs exceed threshold', async () => {
    const slowTrace = createTrace({
      traceId: 'trace_slow',
      totalDurationMs: 15_000,
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_agent_traces') return Promise.resolve(SUMMARY_FIXTURE);
      if (cmd === 'read_agent_trace') return Promise.resolve(JSON.stringify(slowTrace));
      return Promise.resolve(null);
    });

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/slow run.*detected/i)).toBeInTheDocument();
    });
  });

  it('should not show metrics panel when no traces exist', async () => {
    mockInvoke.mockResolvedValue([]);

    render(<DeveloperSettings />);

    await waitFor(() => {
      expect(screen.getByText(/no agent traces recorded/i)).toBeInTheDocument();
    });

    expect(screen.queryByText('Runs')).not.toBeInTheDocument();
    expect(screen.queryByText('Avg Time')).not.toBeInTheDocument();
  });
});
