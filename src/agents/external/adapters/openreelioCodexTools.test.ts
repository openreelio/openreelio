import { invoke } from '@tauri-apps/api/core';
import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildOpenReelioCodexDeveloperInstructions,
  executeOpenReelioAgentToolCall,
  handleOpenReelioCodexDynamicToolCall,
  OPENREELIO_CODEX_DYNAMIC_TOOLS,
  type OpenReelioCodexToolContext,
} from './openreelioCodexTools';
import {
  isCodexDynamicToolCallOutputTextItem,
  type CodexAppServerRequest,
  type CodexDynamicToolCallResponse,
  type CodexJsonObject,
} from './CodexAppServerClient';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

const CONTEXT: OpenReelioCodexToolContext = {
  projectId: 'project-1',
  cwd: 'D:/projects/demo',
  runtimeId: 'codex',
  sessionId: 'session-1',
  sessionKnown: true,
};

/** One-pixel JPEG stand-in; only its base64-ness matters to these tests. */
const IMAGE_BASE64 = 'Zm9vYmFyYmF6cXV1eA==';

/**
 * The Claude-side render wait, kept 90s under the loopback MCP server's 900s
 * `render_proxy` timeout so the answer still reaches a listening backend.
 */
const CLAUDE_RENDER_BUDGET_MS = 13.5 * 60 * 1000;

type EventHandler = (event: Event<unknown>) => void;

function makeEvent<T>(payload: T): Event<T> {
  return { event: 'e', id: 1, payload } as unknown as Event<T>;
}

function callRequest(tool: string, args: CodexJsonObject = {}): CodexAppServerRequest {
  return {
    id: 1,
    method: 'item/tool/call',
    params: { tool, arguments: args },
  };
}

async function callTool(
  tool: string,
  args: CodexJsonObject = {},
): Promise<CodexDynamicToolCallResponse> {
  const response = await handleOpenReelioCodexDynamicToolCall(callRequest(tool, args), CONTEXT);
  if (!response) {
    throw new Error(`Expected a response for '${tool}'`);
  }
  return response;
}

function responseText(response: CodexDynamicToolCallResponse): string {
  return response.contentItems
    .filter(isCodexDynamicToolCallOutputTextItem)
    .map((item) => item.text)
    .join('\n');
}

/**
 * Register a `listen` mock that captures the handler per event name and lets a
 * test emit into it. Renders resolve through events, so this is the external
 * boundary the render tests drive.
 */
function stubListen(): { handlers: Map<string, EventHandler>; unlistened: () => number } {
  const handlers = new Map<string, EventHandler>();
  let unlistenCount = 0;
  vi.mocked(listen).mockImplementation((eventName: string, handler: unknown) => {
    handlers.set(eventName, handler as EventHandler);
    return Promise.resolve<UnlistenFn>(() => {
      unlistenCount += 1;
    });
  });
  return { handlers, unlistened: () => unlistenCount };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('openreelio.frame_extract', () => {
  it('should ask the frame probe for inline bytes and return the pictures before the report', async () => {
    vi.mocked(invoke).mockResolvedValue({
      payload: {
        status: 'ok',
        mode: 'grid',
        sheet: { path: 'C:/demo/.openreelio/cache/frames/a/sheet.jpg', cols: 2, rows: 2 },
      },
      images: [
        {
          path: 'C:/demo/.openreelio/cache/frames/a/sheet.jpg',
          mimeType: 'image/jpeg',
          data: IMAGE_BASE64,
        },
      ],
    });

    const response = await callTool('frame_extract', { affected: true, grid: 'auto' });

    expect(invoke).toHaveBeenCalledWith(
      'extract_timeline_frames',
      expect.objectContaining({
        request: expect.objectContaining({ affected: true, grid: 'auto', inline: true }),
      }),
    );

    expect(response.success).toBe(true);
    expect(response.contentItems[0]).toEqual({
      type: 'inputImage',
      imageUrl: `data:image/jpeg;base64,${IMAGE_BASE64}`,
    });
    expect(response.contentItems[1]?.type).toBe('inputText');

    const text = responseText(response);
    expect(text).not.toContain(IMAGE_BASE64);
    expect(text).toContain('C:/demo/.openreelio/cache/frames/a/sheet.jpg');
  });

  it('should keep every returned still as its own image block', async () => {
    vi.mocked(invoke).mockResolvedValue({
      payload: { status: 'ok', mode: 'timeline', frames: [{ timelineSec: 1 }, { timelineSec: 2 }] },
      images: [
        { path: 'a.png', mimeType: 'image/png', data: IMAGE_BASE64 },
        { path: 'b.png', mimeType: 'image/png', data: IMAGE_BASE64 },
      ],
    });

    const response = await callTool('frame_extract', { times: [1, 2] });

    expect(response.contentItems.filter((item) => item.type === 'inputImage')).toHaveLength(2);
    expect(JSON.parse(responseText(response)).imageCount).toBe(2);
  });

  it('should report a probe rejection as a failed tool call', async () => {
    vi.mocked(invoke).mockRejectedValue('--affected reads the ranges the last edit changed');

    const response = await callTool('frame_extract', { affected: true });

    expect(response.success).toBe(false);
    expect(response.contentItems).toHaveLength(1);
    expect(responseText(response)).toContain('--affected reads the ranges the last edit changed');
  });

  it('should reject a between range that is not a pair', async () => {
    const response = await callTool('frame_extract', { between: [1] });

    expect(response.success).toBe(false);
    expect(responseText(response)).toContain('between');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('openreelio.render_proxy', () => {
  function stubProject(): void {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === 'get_project_info') {
        return Promise.resolve({ id: 'project-1', name: 'Demo', path: 'D:/projects/demo' });
      }
      if (command === 'get_project_state') {
        return Promise.resolve({ activeSequenceId: 'seq-1', assets: [], sequences: [] });
      }
      if (command === 'render_range') {
        return Promise.resolve({ jobId: 'job-1', outputPath: 'ignored', status: 'started' });
      }
      return Promise.reject(new Error(`unexpected command '${command}'`));
    });
  }

  it('should wait for the render to complete and hand back the file it wrote', async () => {
    const { handlers, unlistened } = stubListen();
    stubProject();

    const pending = callTool('render_proxy', { start: 2, end: 6 });
    await vi.waitFor(() => {
      expect(handlers.has('render-complete')).toBe(true);
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(true);
    });

    handlers.get('render-complete')?.(
      makeEvent({
        jobId: 'job-1',
        outputPath: 'D:/projects/demo/.openreelio/cache/renders/agent/proxy-1.mp4',
        durationSec: 4,
        fileSize: 1024,
        encodingTimeSec: 3,
      }),
    );

    const response = await pending;
    const result = JSON.parse(responseText(response));

    expect(response.success).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.jobId).toBe('job-1');
    expect(result.outputPath).toBe('D:/projects/demo/.openreelio/cache/renders/agent/proxy-1.mp4');
    expect(result.durationSec).toBe(4);
    // The follow-up must be a request the probe accepts: samplers are not
    // available with `file`, and `between` needs an explicit grid.
    expect(result.nextStep).toContain('openreelio.frame_extract');
    expect(result.nextStep).toContain('file: outputPath');
    expect(result.nextStep).toContain('between: [0, 4]');
    expect(result.nextStep).toContain("grid: '4x3'");
    expect(result.nextStep).not.toContain("grid: 'auto'");
    expect(unlistened()).toBe(2);
  });

  it('should name the follow-up tool the way the calling host names it', async () => {
    const { handlers } = stubListen();
    stubProject();

    const pending = handleOpenReelioCodexDynamicToolCall(
      callRequest('render_proxy', { start: 0, end: 1 }),
      { ...CONTEXT, runtimeId: 'claude_code' },
    );
    await vi.waitFor(() => {
      expect(handlers.has('render-complete')).toBe(true);
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(true);
    });

    handlers.get('render-complete')?.(
      makeEvent({
        jobId: 'job-1',
        outputPath: 'D:/projects/demo/.openreelio/cache/renders/agent/proxy-1.mp4',
        durationSec: 1,
        fileSize: 1,
        encodingTimeSec: 1,
      }),
    );

    const response = await pending;
    if (!response) {
      throw new Error('Expected a render_proxy response');
    }
    const result = JSON.parse(responseText(response));
    expect(result.nextStep).toContain('mcp__openreelio__frame_extract');
    expect(result.nextStep).not.toContain('openreelio.frame_extract');
  });

  it('should write the draft inside the project cache and send the proxy preset unchanged', async () => {
    const { handlers } = stubListen();
    stubProject();

    const pending = callTool('render_proxy', { start: 0, end: 1 });
    await vi.waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(true);
    });

    const call = vi.mocked(invoke).mock.calls.find(([name]) => name === 'render_range');
    const args = call?.[1] as { outputPath: string; preset: string; sequenceId: string };
    expect(args.outputPath.startsWith('D:/projects/demo/.openreelio/cache/renders/agent/')).toBe(
      true,
    );
    expect(args.outputPath.endsWith('.mp4')).toBe(true);
    expect(args.sequenceId).toBe('seq-1');
    // The desktop host serves `proxy_480p` itself now, so nothing is
    // substituted and the draft keeps the sequence's own frame shape.
    expect(args.preset).toBe('proxy_480p');

    handlers.get('render-complete')?.(
      makeEvent({
        jobId: 'job-1',
        outputPath: args.outputPath,
        durationSec: 1,
        fileSize: 1,
        encodingTimeSec: 1,
      }),
    );

    const result = JSON.parse(responseText(await pending));
    expect(result.preset).toBe('proxy_480p');
    expect(result.warnings).toBeUndefined();
  });

  it('should refuse a delivery preset so the .mp4 draft path stays honest', async () => {
    stubListen();
    stubProject();

    const response = await callTool('render_proxy', { start: 0, end: 1, preset: 'prores' });

    expect(response.success).toBe(false);
    expect(responseText(response)).toContain('proxy_480p');
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(false);
  });

  it('should settle from a terminal event that arrives before the job id is known', async () => {
    const { handlers } = stubListen();
    // A holder rather than a local: TypeScript narrows a `let` assigned only
    // inside a callback down to `null` at every later use.
    const start: { release: (() => void) | null } = { release: null };
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === 'get_project_info') {
        return Promise.resolve({ id: 'project-1', name: 'Demo', path: 'D:/projects/demo' });
      }
      if (command === 'get_project_state') {
        return Promise.resolve({ activeSequenceId: 'seq-1', assets: [], sequences: [] });
      }
      if (command === 'render_range') {
        return new Promise((resolve) => {
          start.release = () =>
            resolve({ jobId: 'job-1', outputPath: 'ignored', status: 'started' });
        });
      }
      return Promise.reject(new Error(`unexpected command '${command}'`));
    });

    const pending = callTool('render_proxy', { start: 0, end: 1 });
    await vi.waitFor(() => {
      expect(start.release).not.toBeNull();
    });

    // The encoder finished before `render_range` even answered with its id.
    handlers.get('render-complete')?.(
      makeEvent({
        jobId: 'job-1',
        outputPath: 'D:/projects/demo/.openreelio/cache/renders/agent/proxy-early.mp4',
        durationSec: 1,
        fileSize: 2,
        encodingTimeSec: 1,
      }),
    );
    start.release?.();

    const result = JSON.parse(responseText(await pending));
    expect(result.status).toBe('ok');
    expect(result.outputPath).toContain('proxy-early.mp4');
  });

  it('should ignore a terminal event for another job', async () => {
    const { handlers } = stubListen();
    stubProject();

    let settled = false;
    const pending = callTool('render_proxy', { start: 0, end: 1 }).then((response) => {
      settled = true;
      return response;
    });
    await vi.waitFor(() => {
      expect(handlers.has('render-complete')).toBe(true);
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(true);
    });

    handlers.get('render-complete')?.(
      makeEvent({
        jobId: 'someone-elses-job',
        outputPath: 'D:/projects/demo/other.mp4',
        durationSec: 9,
        fileSize: 9,
        encodingTimeSec: 9,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    handlers.get('render-complete')?.(
      makeEvent({
        jobId: 'job-1',
        outputPath: 'D:/projects/demo/mine.mp4',
        durationSec: 1,
        fileSize: 1,
        encodingTimeSec: 1,
      }),
    );

    const result = JSON.parse(responseText(await pending));
    expect(result.outputPath).toBe('D:/projects/demo/mine.mp4');
  });

  it('should report a failed render as failed and name no output file', async () => {
    const { handlers } = stubListen();
    stubProject();

    const pending = callTool('render_proxy', { start: 0, end: 1 });
    await vi.waitFor(() => {
      expect(handlers.has('render-lifecycle')).toBe(true);
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(true);
    });

    handlers.get('render-lifecycle')?.(
      makeEvent({
        jobId: 'job-1',
        sequenceId: 'seq-1',
        kind: 'range_export',
        state: 'failed',
        progress: null,
        message: 'Encoder exited with status 1',
        outputPath: null,
        planHash: null,
      }),
    );

    const response = await pending;
    const result = JSON.parse(responseText(response));
    expect(response.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('Encoder exited');
    // Nothing was written, so there is no file to point frame_extract at.
    expect(result.outputPath).toBeUndefined();
    expect(result.nextStep).toBeUndefined();
  });

  it('should refuse a range longer than the draft cap', async () => {
    stubListen();
    stubProject();

    const response = await callTool('render_proxy', { start: 0, end: 400 });

    expect(response.success).toBe(false);
    expect(responseText(response)).toContain('300s');
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(false);
  });

  it('should separate a cancelled render from a failed one', async () => {
    const { handlers } = stubListen();
    stubProject();

    const pending = callTool('render_proxy', { start: 0, end: 1 });
    await vi.waitFor(() => {
      expect(handlers.has('render-lifecycle')).toBe(true);
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(true);
    });

    handlers.get('render-lifecycle')?.(
      makeEvent({
        jobId: 'job-1',
        sequenceId: 'seq-1',
        kind: 'range_export',
        state: 'cancelled',
        progress: null,
        message: 'Export cancelled',
        outputPath: null,
        planHash: null,
      }),
    );

    const response = await pending;
    expect(response.success).toBe(false);
    expect(JSON.parse(responseText(response)).status).toBe('cancelled');
  });

  function stubStuckRender(): void {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === 'get_project_info') {
        return Promise.resolve({ id: 'project-1', name: 'Demo', path: 'D:/projects/demo' });
      }
      if (command === 'get_project_state') {
        return Promise.resolve({ activeSequenceId: 'seq-1', assets: [], sequences: [] });
      }
      if (command === 'render_range') {
        return Promise.resolve({ jobId: 'job-1', outputPath: 'ignored', status: 'started' });
      }
      if (command === 'cancel_render') {
        return Promise.resolve({ jobId: 'job-1', cancelled: true });
      }
      return Promise.reject(new Error(`unexpected command '${command}'`));
    });
  }

  async function waitForRenderStart(): Promise<void> {
    await vi.waitFor(async () => {
      await Promise.resolve();
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(true);
    });
  }

  it('should cancel the job and report a timeout when the render never finishes', async () => {
    vi.useFakeTimers();
    try {
      stubListen();
      stubStuckRender();

      const pending = callTool('render_proxy', { start: 0, end: 1 });
      await waitForRenderStart();

      // Still waiting just short of the Codex budget.
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'cancel_render')).toBe(false);

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      const result = JSON.parse(responseText(await pending));
      expect(result.status).toBe('timeout');
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'cancel_render')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should give up before the loopback MCP call timeout on a Claude session', async () => {
    vi.useFakeTimers();
    try {
      stubListen();
      stubStuckRender();

      const pending = handleOpenReelioCodexDynamicToolCall(
        callRequest('render_proxy', { start: 0, end: 1 }),
        { ...CONTEXT, runtimeId: 'claude_code' },
      );
      await waitForRenderStart();

      // The backend abandons a `render_proxy` call at 900s; the wait must end
      // first, with margin for the answer to travel back.
      await vi.advanceTimersByTimeAsync(CLAUDE_RENDER_BUDGET_MS);

      const response = await pending;
      if (!response) {
        throw new Error('Expected a render_proxy response');
      }
      expect(JSON.parse(responseText(response)).status).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should count the budget from when the call arrived, not from when the render starts', async () => {
    vi.useFakeTimers();
    try {
      stubListen();
      // A slow preamble: reading project state costs four minutes before the
      // render can even be started.
      const preambleMs = 4 * 60 * 1000;
      const slowRead = <T>(value: T): Promise<T> =>
        new Promise<T>((resolve) => {
          setTimeout(() => resolve(value), preambleMs);
        });
      vi.mocked(invoke).mockImplementation((command: string) => {
        if (command === 'get_project_info') {
          return slowRead({ id: 'project-1', name: 'Demo', path: 'D:/projects/demo' });
        }
        if (command === 'get_project_state') {
          return slowRead({ activeSequenceId: 'seq-1', assets: [], sequences: [] });
        }
        if (command === 'render_range') {
          return Promise.resolve({ jobId: 'job-1', outputPath: 'ignored', status: 'started' });
        }
        if (command === 'cancel_render') {
          return Promise.resolve({ jobId: 'job-1', cancelled: true });
        }
        return Promise.reject(new Error(`unexpected command '${command}'`));
      });

      const startedAt = Date.now();
      let settledAt = 0;
      const pending = handleOpenReelioCodexDynamicToolCall(
        callRequest('render_proxy', { start: 0, end: 1 }),
        { ...CONTEXT, runtimeId: 'claude_code' },
      ).then((response) => {
        settledAt = Date.now();
        return response;
      });

      await vi.advanceTimersByTimeAsync(preambleMs);
      await waitForRenderStart();
      await vi.advanceTimersByTimeAsync(CLAUDE_RENDER_BUDGET_MS);

      const response = await pending;
      if (!response) {
        throw new Error('Expected a render_proxy response');
      }
      expect(JSON.parse(responseText(response)).status).toBe('timeout');
      // A budget armed after the preamble would have answered at 4 + 13.5
      // minutes, long after the backend stopped listening.
      expect(settledAt - startedAt).toBeLessThanOrEqual(CLAUDE_RENDER_BUDGET_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not await the cancellation before answering a timeout', async () => {
    vi.useFakeTimers();
    try {
      stubListen();
      vi.mocked(invoke).mockImplementation((command: string) => {
        if (command === 'get_project_info') {
          return Promise.resolve({ id: 'project-1', name: 'Demo', path: 'D:/projects/demo' });
        }
        if (command === 'get_project_state') {
          return Promise.resolve({ activeSequenceId: 'seq-1', assets: [], sequences: [] });
        }
        if (command === 'render_range') {
          return Promise.resolve({ jobId: 'job-1', outputPath: 'ignored', status: 'started' });
        }
        if (command === 'cancel_render') {
          // A backend that never answers must not hold the tool call open.
          return new Promise(() => undefined);
        }
        return Promise.reject(new Error(`unexpected command '${command}'`));
      });

      const pending = callTool('render_proxy', { start: 0, end: 1 });
      await waitForRenderStart();
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      const result = JSON.parse(responseText(await pending));
      expect(result.status).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should refuse a range whose end is not after its start', async () => {
    stubListen();
    stubProject();

    const response = await callTool('render_proxy', { start: 5, end: 5 });

    expect(response.success).toBe(false);
    expect(responseText(response)).toContain('greater than start');
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(false);
  });
});

describe('executeOpenReelioAgentToolCall', () => {
  it('should route pictures into images and keep base64 out of the text', async () => {
    vi.mocked(invoke).mockResolvedValue({
      payload: { status: 'ok', mode: 'grid', sheet: { path: 'sheet.jpg' } },
      images: [{ path: 'sheet.jpg', mimeType: 'image/jpeg', data: IMAGE_BASE64 }],
    });

    const result = await executeOpenReelioAgentToolCall({
      toolName: 'frame_extract',
      args: { perShot: true, grid: 'auto' },
      context: { ...CONTEXT, runtimeId: 'claude_code' },
    });

    expect(result.isError).toBe(false);
    expect(result.images).toEqual([{ data: IMAGE_BASE64, mimeType: 'image/jpeg' }]);
    expect(result.text).not.toContain(IMAGE_BASE64);
    expect(result.text).not.toContain('data:image');
    expect(result.text).toContain('sheet.jpg');
  });

  it('should omit images entirely for a text-only tool', async () => {
    vi.mocked(invoke).mockResolvedValue({
      activeSequenceId: 'seq-1',
      assets: [],
      sequences: [],
    });

    const result = await executeOpenReelioAgentToolCall({
      toolName: 'timeline_snapshot',
      args: {},
      context: { ...CONTEXT, runtimeId: 'claude_code' },
    });

    expect(result.images).toBeUndefined();
  });
});

describe('developer instructions', () => {
  const instructions = buildOpenReelioCodexDeveloperInstructions({
    projectId: 'project-1',
    cwd: 'D:/projects/demo',
  });

  it('should tell the agent to look at the edit after applying it', () => {
    expect(instructions).toContain('openreelio.frame_extract');
    expect(instructions).toContain("affected: true, grid: 'auto'");
    expect(instructions).toContain('atCaptions: true');
    expect(instructions).toContain('perShot: true');
    expect(instructions).toContain('openreelio.render_proxy');
  });

  it('should name every tool in the dotted form the Claude adapter rewrites', () => {
    for (const tool of ['frame_extract', 'render_proxy']) {
      expect(instructions).toContain(`openreelio.${tool}`);
      expect(instructions).not.toContain(`mcp__openreelio__${tool}`);
    }
  });

  it('should advertise both new tools in the catalog', () => {
    const names = OPENREELIO_CODEX_DYNAMIC_TOOLS.map((tool) => tool.name);
    expect(names).toContain('frame_extract');
    expect(names).toContain('render_proxy');
  });

  it('should only recommend frame_extract requests the probe accepts', () => {
    for (const recipe of INSTRUCTION_RECIPES) {
      expect(instructions).toContain(recipe.text);
      expect({ recipe: recipe.text, rejection: frameProbeRejection(recipe.request) }).toEqual({
        recipe: recipe.text,
        rejection: null,
      });
    }
  });

  it('should never offer a bare between fallback', () => {
    // `between` without an explicit COLSxROWS is rejected outright, so it must
    // not appear as the thing to reach for when a sampler comes back empty.
    expect(instructions).not.toContain('between: [start, end]');
    for (const line of instructions.split('\n').filter((entry) => entry.includes('between:'))) {
      expect(line).toMatch(/grid: '\d+x\d+'/);
    }
  });
});

/** A frame_extract request as the instructions spell it. */
interface FrameProbeRecipe {
  time?: number;
  times?: number[];
  between?: [number, number];
  count?: number;
  asset?: string;
  file?: string;
  grid?: string;
  cellWidth?: number;
  cellHeight?: number;
  labelCells?: boolean;
  atCuts?: boolean;
  atTransitions?: boolean;
  atCaptions?: boolean;
  atMarkers?: boolean;
  perShot?: boolean;
  around?: number;
  span?: number;
  limit?: number;
  affected?: boolean;
}

const SAMPLER_EXCLUSIVE_KEYS = ['time', 'times', 'between', 'count', 'asset', 'file'] as const;
const GRID_ONLY_KEYS = ['between', 'count', 'cellWidth', 'cellHeight', 'labelCells'] as const;

/**
 * Mirror of the three request checks the Rust frame probe applies, so a recipe
 * the instructions hand an agent cannot silently become one the probe rejects.
 *
 * Sources: `ensure_sampler_selectors_unused`, `ensure_grid_only_flags_unused`
 * and `resolve_auto_grid_selection` in
 * `src-tauri/src/core/render/frame_probe/mod.rs`.
 */
function frameProbeRejection(recipe: FrameProbeRecipe): string | null {
  const samplerActive = Boolean(
    recipe.atCuts ||
    recipe.atTransitions ||
    recipe.atCaptions ||
    recipe.atMarkers ||
    recipe.perShot ||
    recipe.affected ||
    recipe.around !== undefined,
  );

  const named = SAMPLER_EXCLUSIVE_KEYS.filter((key) => recipe[key] !== undefined);
  if (samplerActive && named.length > 0) {
    return `a sampler cannot be combined with ${named.join(', ')}`;
  }

  const gridOnly = GRID_ONLY_KEYS.filter(
    (key) => recipe[key] !== undefined && recipe[key] !== false,
  );
  if (!recipe.grid && gridOnly.length > 0) {
    return `${gridOnly.join(', ')} requires grid`;
  }

  if (recipe.grid === 'auto' && !samplerActive && recipe.times === undefined) {
    return "grid 'auto' needs a sampler or times";
  }
  if (recipe.grid && recipe.grid !== 'auto' && !recipe.between && !recipe.times) {
    return 'a grid needs between or times';
  }

  return null;
}

/** Every frame_extract request the developer instructions spell out. */
const INSTRUCTION_RECIPES: Array<{ text: string; request: FrameProbeRecipe }> = [
  {
    text: "affected: true, grid: 'auto', labelCells: true",
    request: { affected: true, grid: 'auto', labelCells: true },
  },
  { text: "atCuts: true, grid: 'auto'", request: { atCuts: true, grid: 'auto' } },
  {
    text: "around: <edited time>, span: 1, grid: 'auto'",
    request: { around: 12, span: 1, grid: 'auto' },
  },
  {
    text: "atCaptions: true, grid: 'auto', cellWidth: 640",
    request: { atCaptions: true, grid: 'auto', cellWidth: 640 },
  },
  {
    text: "perShot: true, grid: 'auto', limit: 24",
    request: { perShot: true, grid: 'auto', limit: 24 },
  },
  {
    text: "{ file: outputPath, between: [0, durationSec], grid: '4x3', labelCells: true }",
    request: { file: 'draft.mp4', between: [0, 12], grid: '4x3', labelCells: true },
  },
];

describe('frameProbeRejection', () => {
  it('should reject the requests the Rust probe rejects', () => {
    expect(frameProbeRejection({ between: [0, 10] })).toContain('requires grid');
    expect(frameProbeRejection({ atCaptions: true, cellWidth: 640 })).toContain('requires grid');
    expect(frameProbeRejection({ between: [0, 10], grid: 'auto' })).toContain('sampler or times');
    expect(frameProbeRejection({ file: 'draft.mp4', atCuts: true, grid: 'auto' })).toContain(
      'sampler cannot be combined',
    );
  });

  it('should accept a sampler sheet and a file sweep', () => {
    expect(frameProbeRejection({ atCuts: true, grid: 'auto' })).toBeNull();
    expect(frameProbeRejection({ file: 'draft.mp4', between: [0, 5], grid: '4x3' })).toBeNull();
    expect(frameProbeRejection({ times: [1, 2], grid: 'auto' })).toBeNull();
  });
});

describe('openreelio.preview_describe', () => {
  it('should point at the frame probe instead of claiming raw frame access', async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === 'get_project_state') {
        return Promise.resolve({ activeSequenceId: null, assets: [], sequences: [] });
      }
      return Promise.resolve(false);
    });

    const text = responseText(await callTool('preview_describe'));
    const parsed = JSON.parse(text) as { mediaInspection: Record<string, unknown> };

    expect(parsed.mediaInspection.rawFrameAccess).toBeUndefined();
    expect(parsed.mediaInspection.frameExtraction).toBe('openreelio.frame_extract');
    expect(String(parsed.mediaInspection.message)).toContain('openreelio.frame_extract');
  });

  it('should spell the pointers the way a Claude session sees them', async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === 'get_project_state') {
        return Promise.resolve({ activeSequenceId: null, assets: [], sequences: [] });
      }
      return Promise.resolve(false);
    });

    const response = await handleOpenReelioCodexDynamicToolCall(callRequest('preview_describe'), {
      ...CONTEXT,
      runtimeId: 'claude_code',
    });
    if (!response) {
      throw new Error('Expected a preview_describe response');
    }
    const parsed = JSON.parse(responseText(response)) as {
      mediaInspection: Record<string, unknown>;
    };

    expect(parsed.mediaInspection.frameExtraction).toBe('mcp__openreelio__frame_extract');
    expect(parsed.mediaInspection.rangeRender).toBe('mcp__openreelio__render_proxy');
    expect(String(parsed.mediaInspection.message)).not.toContain('openreelio.frame_extract');
  });
});
