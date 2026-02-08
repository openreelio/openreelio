/**
 * AgenticSidebarContent Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgenticSidebarContent } from './AgenticSidebarContent';
import { useConversationStore } from '@/stores/conversationStore';

// Mock feature flags
vi.mock('@/config/featureFlags', () => ({
  isAgenticEngineEnabled: vi.fn(() => true),
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the adapters
vi.mock('@/agents/engine/adapters/llm/TauriLLMAdapter', () => ({
  TauriLLMAdapter: vi.fn(),
  createTauriLLMAdapter: vi.fn(() => ({
    provider: 'tauri',
    complete: vi.fn().mockResolvedValue({
      content: '{}',
      finishReason: 'stop',
    }),
    generateStream: vi.fn(),
    generateWithTools: vi.fn(),
    generateStructured: vi.fn().mockResolvedValue({}),
    abort: vi.fn(),
    isGenerating: vi.fn(() => false),
    isConfigured: vi.fn(() => true),
  })),
}));

vi.mock('@/agents/engine/adapters/tools/ToolRegistryAdapter', () => ({
  ToolRegistryAdapter: vi.fn(),
  createToolRegistryAdapter: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue({ success: true, data: {}, duration: 100 }),
    executeBatch: vi.fn().mockResolvedValue({ results: [], totalDuration: 100, failedCount: 0 }),
    getAvailableTools: vi.fn().mockReturnValue([]),
  })),
}));

// Mock project store
vi.mock('@/stores', () => ({
  useProjectStore: vi.fn((selector) => {
    const state = {
      activeSequenceId: 'seq-1',
      sequences: new Map([
        [
          'seq-1',
          {
            id: 'seq-1',
            name: 'Test Sequence',
            format: {
              canvas: { width: 1920, height: 1080 },
              fps: { num: 30, den: 1 },
              audioSampleRate: 48000,
              audioChannels: 2,
            },
            tracks: [
              { id: 'track-1', name: 'Video 1', kind: 'video', clips: [] },
              { id: 'track-2', name: 'Audio 1', kind: 'audio', clips: [] },
            ],
            markers: [],
          },
        ],
      ]),
      assets: new Map([
        [
          'asset-1',
          {
            id: 'asset-1',
            kind: 'video',
            name: 'video.mp4',
            durationSec: 60,
          },
        ],
        [
          'asset-2',
          {
            id: 'asset-2',
            kind: 'audio',
            name: 'audio.mp3',
            durationSec: 120,
          },
        ],
      ]),
    };
    return selector(state);
  }),
}));

describe('AgenticSidebarContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationStore.getState().loadForProject('test-project');
  });

  afterEach(() => {
    useConversationStore.getState().clearConversation();
  });

  describe('rendering', () => {
    it('should render the agentic sidebar content', () => {
      render(<AgenticSidebarContent />);

      expect(screen.getByTestId('agentic-sidebar-content')).toBeInTheDocument();
    });

    it('should render the agentic chat interface', () => {
      render(<AgenticSidebarContent />);

      expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
    });

    it('should render input field', () => {
      render(<AgenticSidebarContent />);

      expect(screen.getByPlaceholderText(/describe what you want to edit/i)).toBeInTheDocument();
    });
  });

  describe('visibility', () => {
    it('should not render when visible is false', () => {
      render(<AgenticSidebarContent visible={false} />);

      expect(screen.queryByTestId('agentic-sidebar-content')).not.toBeInTheDocument();
    });

    it('should render when visible is true', () => {
      render(<AgenticSidebarContent visible={true} />);

      expect(screen.getByTestId('agentic-sidebar-content')).toBeInTheDocument();
    });
  });

  describe('className', () => {
    it('should apply custom className', () => {
      render(<AgenticSidebarContent className="custom-class" />);

      expect(screen.getByTestId('agentic-sidebar-content')).toHaveClass('custom-class');
    });
  });
});
