/**
 * SelectionBox Component Tests
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SelectionBox } from './SelectionBox';

describe('SelectionBox Component', () => {
  it('should not render when not active', () => {
    const { container } = render(
      <SelectionBox rect={null} isActive={false} />
    );

    expect(container.querySelector('[data-testid="selection-box"]')).toBeNull();
  });

  it('should not render when rect is null', () => {
    const { container } = render(
      <SelectionBox rect={null} isActive={true} />
    );

    expect(container.querySelector('[data-testid="selection-box"]')).toBeNull();
  });

  it('should render selection rectangle when active with valid rect', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 };
    const { container } = render(
      <SelectionBox rect={rect} isActive={true} />
    );

    const box = container.querySelector('[data-testid="selection-box"]');
    expect(box).not.toBeNull();
    expect(box).toHaveStyle({
      left: '100px',
      top: '50px',
      width: '200px',
      height: '100px',
    });
  });

  it('should not render very small selection rectangles (width < 2)', () => {
    const rect = { left: 100, top: 50, width: 1, height: 100 };
    const { container } = render(
      <SelectionBox rect={rect} isActive={true} />
    );

    expect(container.querySelector('[data-testid="selection-box"]')).toBeNull();
  });

  it('should not render very small selection rectangles (height < 2)', () => {
    const rect = { left: 100, top: 50, width: 100, height: 1 };
    const { container } = render(
      <SelectionBox rect={rect} isActive={true} />
    );

    expect(container.querySelector('[data-testid="selection-box"]')).toBeNull();
  });

  it('should have correct CSS classes for styling', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 };
    const { container } = render(
      <SelectionBox rect={rect} isActive={true} />
    );

    const box = container.querySelector('[data-testid="selection-box"]');
    expect(box).toHaveClass('absolute');
    expect(box).toHaveClass('pointer-events-none');
    expect(box).toHaveClass('border-2');
    expect(box).toHaveClass('z-30');
  });
});
