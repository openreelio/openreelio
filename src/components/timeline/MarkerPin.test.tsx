/**
 * MarkerPin Component Tests
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MarkerPin } from './MarkerPin';
import type { Marker, Color } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const createTestMarker = (overrides?: Partial<Marker>): Marker => ({
  id: 'marker_001',
  timeSec: 10,
  label: 'Test Marker',
  color: { r: 255, g: 0, b: 0 },
  markerType: 'generic',
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('MarkerPin', () => {
  describe('Rendering', () => {
    it('renders marker pin at correct position', () => {
      const marker = createTestMarker({ timeSec: 5 });
      const zoom = 100; // 100px per second

      render(<MarkerPin marker={marker} zoom={zoom} selected={false} />);

      const pin = screen.getByTestId('marker-pin-marker_001');
      // Position should be 5s * 100px/s = 500px, centered with translateX(-50%)
      expect(pin).toHaveStyle({ left: '500px' });
    });

    it('renders with marker label in title', () => {
      const marker = createTestMarker({ label: 'Important point' });

      render(<MarkerPin marker={marker} zoom={100} selected={false} />);

      const pin = screen.getByTestId('marker-pin-marker_001');
      expect(pin).toHaveAttribute('title', expect.stringContaining('Important point'));
    });
  });

  describe('Marker Types', () => {
    it.each(['generic', 'chapter', 'hook', 'cta', 'todo'] as const)(
      'renders %s marker type',
      (markerType) => {
        const marker = createTestMarker({ markerType, id: `marker_${markerType}` });

        render(<MarkerPin marker={marker} zoom={100} selected={false} />);

        const pin = screen.getByTestId(`marker-pin-marker_${markerType}`);
        expect(pin).toBeInTheDocument();
      }
    );
  });

  describe('Colors', () => {
    it('uses marker color when provided', () => {
      const color: Color = { r: 0, g: 255, b: 0 };
      const marker = createTestMarker({ color });

      render(<MarkerPin marker={marker} zoom={100} selected={false} />);

      const pin = screen.getByTestId('marker-pin-marker_001');
      const head = pin.querySelector('div > div');
      expect(head).toHaveStyle({ backgroundColor: 'rgba(0, 255, 0, 1)' });
    });

    it('uses default color for marker type when color is not meaningful', () => {
      const marker = createTestMarker({
        markerType: 'chapter',
        color: { r: 0, g: 0, b: 0 } // All zeros
      });

      render(<MarkerPin marker={marker} zoom={100} selected={false} />);

      // Should use default blue for chapter markers
      const pin = screen.getByTestId('marker-pin-marker_001');
      expect(pin).toBeInTheDocument();
    });
  });

  describe('Selection', () => {
    it('applies selected styling when selected', () => {
      const marker = createTestMarker();

      render(<MarkerPin marker={marker} zoom={100} selected={true} />);

      const pin = screen.getByTestId('marker-pin-marker_001');
      expect(pin.className).toContain('z-20');
    });

    it('does not apply selected z-index when not selected', () => {
      const marker = createTestMarker();

      render(<MarkerPin marker={marker} zoom={100} selected={false} />);

      const pin = screen.getByTestId('marker-pin-marker_001');
      expect(pin.className).toContain('z-10');
      expect(pin.className).not.toContain('z-20');
    });
  });

  describe('Click Handling', () => {
    it('calls onClick with marker id and modifiers', () => {
      const onClick = vi.fn();
      const marker = createTestMarker({ id: 'click_marker' });

      render(<MarkerPin marker={marker} zoom={100} selected={false} onClick={onClick} />);

      const pin = screen.getByTestId('marker-pin-click_marker');
      fireEvent.click(pin);

      expect(onClick).toHaveBeenCalledWith('click_marker', expect.objectContaining({
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      }));
    });

    it('passes modifier keys correctly', () => {
      const onClick = vi.fn();
      const marker = createTestMarker();

      render(<MarkerPin marker={marker} zoom={100} selected={false} onClick={onClick} />);

      const pin = screen.getByTestId('marker-pin-marker_001');
      fireEvent.click(pin, { ctrlKey: true, shiftKey: true });

      expect(onClick).toHaveBeenCalledWith(
        'marker_001',
        expect.objectContaining({
          ctrlKey: true,
          shiftKey: true,
        })
      );
    });

    it('does not call onClick when disabled', () => {
      const onClick = vi.fn();
      const marker = createTestMarker();

      render(
        <MarkerPin marker={marker} zoom={100} selected={false} onClick={onClick} disabled={true} />
      );

      const pin = screen.getByTestId('marker-pin-marker_001');
      fireEvent.click(pin);

      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('Double-Click', () => {
    it('calls onDoubleClick when double-clicked', () => {
      const onDoubleClick = vi.fn();
      const marker = createTestMarker({ id: 'dbl_marker' });

      render(
        <MarkerPin marker={marker} zoom={100} selected={false} onDoubleClick={onDoubleClick} />
      );

      const pin = screen.getByTestId('marker-pin-dbl_marker');
      fireEvent.doubleClick(pin);

      expect(onDoubleClick).toHaveBeenCalledWith('dbl_marker');
    });
  });

  describe('Context Menu', () => {
    it('calls onContextMenu when right-clicked', () => {
      const onContextMenu = vi.fn();
      const marker = createTestMarker({ id: 'ctx_marker' });

      render(
        <MarkerPin marker={marker} zoom={100} selected={false} onContextMenu={onContextMenu} />
      );

      const pin = screen.getByTestId('marker-pin-ctx_marker');
      fireEvent.contextMenu(pin);

      expect(onContextMenu).toHaveBeenCalledWith('ctx_marker', expect.any(Object));
    });
  });

  describe('Disabled State', () => {
    it('applies disabled styling', () => {
      const marker = createTestMarker();

      render(<MarkerPin marker={marker} zoom={100} selected={false} disabled={true} />);

      const pin = screen.getByTestId('marker-pin-marker_001');
      expect(pin.className).toContain('opacity-50');
      expect(pin.className).toContain('cursor-not-allowed');
    });
  });
});
