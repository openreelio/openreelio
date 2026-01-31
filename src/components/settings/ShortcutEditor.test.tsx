/**
 * ShortcutEditor Component Tests
 *
 * TDD: Tests for keyboard shortcut customization UI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShortcutEditor } from './ShortcutEditor';
import { useShortcutSettings } from '@/hooks/useShortcutSettings';
import { DEFAULT_SHORTCUTS } from '@/utils/shortcutActions';

// =============================================================================
// Mock useShortcutSettings
// =============================================================================

vi.mock('@/hooks/useShortcutSettings', () => ({
  useShortcutSettings: vi.fn(),
}));

const mockUseShortcutSettings = useShortcutSettings as unknown as ReturnType<typeof vi.fn>;

// =============================================================================
// Tests
// =============================================================================

describe('ShortcutEditor', () => {
  let mockSetShortcut: ReturnType<typeof vi.fn>;
  let mockResetShortcut: ReturnType<typeof vi.fn>;
  let mockResetAllShortcuts: ReturnType<typeof vi.fn>;
  let mockCustomShortcuts: Record<string, string>;

  beforeEach(() => {
    mockCustomShortcuts = {};
    mockSetShortcut = vi.fn();
    mockResetShortcut = vi.fn();
    mockResetAllShortcuts = vi.fn();

    mockUseShortcutSettings.mockReturnValue({
      customShortcuts: mockCustomShortcuts,
      getShortcut: (actionId: string) => mockCustomShortcuts[actionId] ?? DEFAULT_SHORTCUTS[actionId],
      setShortcut: mockSetShortcut,
      resetShortcut: mockResetShortcut,
      resetAllShortcuts: mockResetAllShortcuts,
      isCustomized: (actionId: string) => actionId in mockCustomShortcuts,
      hasConflict: (shortcut: string, excludeActionId?: string) => {
        for (const [id, bound] of Object.entries({ ...DEFAULT_SHORTCUTS, ...mockCustomShortcuts })) {
          if (id !== excludeActionId && bound.toLowerCase() === shortcut.toLowerCase()) {
            return id;
          }
        }
        return null;
      },
      getShortcutsByCategory: () => ({
        playback: [
          { actionId: 'playback.playPause', label: 'Play/Pause', shortcut: 'Space' },
          { actionId: 'playback.stop', label: 'Stop', shortcut: 'Escape' },
        ],
        timeline: [
          { actionId: 'timeline.split', label: 'Split Clip', shortcut: 'S' },
          { actionId: 'timeline.delete', label: 'Delete', shortcut: 'Delete' },
        ],
        project: [
          { actionId: 'project.save', label: 'Save Project', shortcut: 'Ctrl+S' },
          { actionId: 'project.undo', label: 'Undo', shortcut: 'Ctrl+Z' },
        ],
        navigation: [],
        view: [],
        tools: [],
      }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render shortcuts by category', () => {
      render(<ShortcutEditor />);

      // Check category headers
      expect(screen.getByText('Playback')).toBeInTheDocument();
      expect(screen.getByText('Timeline')).toBeInTheDocument();
      expect(screen.getByText('Project')).toBeInTheDocument();
    });

    it('should render action labels', () => {
      render(<ShortcutEditor />);

      expect(screen.getByText('Play/Pause')).toBeInTheDocument();
      expect(screen.getByText('Split Clip')).toBeInTheDocument();
      expect(screen.getByText('Save Project')).toBeInTheDocument();
    });

    it('should render shortcut keys', () => {
      render(<ShortcutEditor />);

      expect(screen.getByText('Space')).toBeInTheDocument();
      expect(screen.getByText('S')).toBeInTheDocument();
      expect(screen.getByText('Ctrl+S')).toBeInTheDocument();
    });

    it('should render reset all button', () => {
      render(<ShortcutEditor />);

      expect(screen.getByRole('button', { name: /reset all/i })).toBeInTheDocument();
    });
  });

  describe('shortcut editing', () => {
    it('should show editing state when clicking shortcut', async () => {
      const user = userEvent.setup();
      render(<ShortcutEditor />);

      const spaceKey = screen.getByText('Space');
      await user.click(spaceKey);

      expect(screen.getByText(/press a key/i)).toBeInTheDocument();
    });

    it('should capture key press and update shortcut', async () => {
      const user = userEvent.setup();
      render(<ShortcutEditor />);

      const spaceKey = screen.getByText('Space');
      await user.click(spaceKey);

      // Simulate pressing P key
      fireEvent.keyDown(document, { key: 'p', code: 'KeyP' });

      expect(mockSetShortcut).toHaveBeenCalledWith('playback.playPause', 'P');
    });

    it('should capture modifier + key combinations', async () => {
      const user = userEvent.setup();
      render(<ShortcutEditor />);

      const spaceKey = screen.getByText('Space');
      await user.click(spaceKey);

      // Simulate pressing Ctrl+P
      fireEvent.keyDown(document, {
        key: 'p',
        code: 'KeyP',
        ctrlKey: true,
      });

      expect(mockSetShortcut).toHaveBeenCalledWith('playback.playPause', 'Ctrl+P');
    });

    it('should cancel editing on Escape', async () => {
      const user = userEvent.setup();
      render(<ShortcutEditor />);

      const spaceKey = screen.getByText('Space');
      await user.click(spaceKey);

      expect(screen.getByText(/press a key/i)).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });

      // Should return to showing Space
      expect(screen.queryByText(/press a key/i)).not.toBeInTheDocument();
      expect(mockSetShortcut).not.toHaveBeenCalled();
    });
  });

  describe('conflict detection', () => {
    it('should show conflict warning when shortcut already used', async () => {
      const user = userEvent.setup();
      render(<ShortcutEditor />);

      // Click on Stop (Esc) to edit it - note: Escape is displayed as "Esc"
      const escapeKey = screen.getByText('Esc');
      await user.click(escapeKey);

      // Try to set it to Space which is used by Play/Pause
      fireEvent.keyDown(document, { key: ' ', code: 'Space' });

      // Should show conflict warning
      expect(screen.getByText(/conflict/i)).toBeInTheDocument();
    });
  });

  describe('reset functionality', () => {
    it('should call resetShortcut when reset button clicked', async () => {
      mockCustomShortcuts['playback.playPause'] = 'P';
      mockUseShortcutSettings.mockReturnValue({
        ...mockUseShortcutSettings(),
        customShortcuts: mockCustomShortcuts,
        isCustomized: (actionId: string) => actionId === 'playback.playPause',
        getShortcut: (actionId: string) =>
          mockCustomShortcuts[actionId] ?? DEFAULT_SHORTCUTS[actionId],
        getShortcutsByCategory: () => ({
          playback: [
            { actionId: 'playback.playPause', label: 'Play/Pause', shortcut: 'P' },
            { actionId: 'playback.stop', label: 'Stop', shortcut: 'Escape' },
          ],
          timeline: [],
          project: [],
          navigation: [],
          view: [],
          tools: [],
        }),
      });

      const user = userEvent.setup();
      render(<ShortcutEditor />);

      // Find the individual reset button (aria-label="Reset shortcut"), not the "Reset All" button
      const resetButton = screen.getByRole('button', { name: 'Reset shortcut' });
      await user.click(resetButton);

      expect(mockResetShortcut).toHaveBeenCalled();
    });

    it('should call resetAllShortcuts when reset all button clicked', async () => {
      const user = userEvent.setup();
      render(<ShortcutEditor />);

      const resetAllButton = screen.getByRole('button', { name: /reset all/i });
      await user.click(resetAllButton);

      expect(mockResetAllShortcuts).toHaveBeenCalled();
    });
  });

  describe('search/filter', () => {
    it('should filter shortcuts by search query', async () => {
      const user = userEvent.setup();
      render(<ShortcutEditor />);

      const searchInput = screen.getByPlaceholderText(/search/i);
      await user.type(searchInput, 'play');

      // Should show Play/Pause
      expect(screen.getByText('Play/Pause')).toBeInTheDocument();

      // Should not show Split Clip
      expect(screen.queryByText('Split Clip')).not.toBeInTheDocument();
    });
  });
});
