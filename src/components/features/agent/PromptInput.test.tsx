import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptInput } from './PromptInput';

describe('PromptInput', () => {
  const focus = vi.fn();
  const originalFocus = HTMLTextAreaElement.prototype.focus;

  beforeEach(() => {
    focus.mockReset();
    Object.defineProperty(HTMLTextAreaElement.prototype, 'focus', {
      configurable: true,
      value: focus,
    });
  });

  afterEach(() => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'focus', {
      configurable: true,
      value: originalFocus,
    });
  });

  it('restores focus without scrolling the surrounding chat layout', async () => {
    const { rerender } = render(
      <PromptInput value="" onChange={() => {}} onSubmit={() => {}} disabled={true} />,
    );

    expect(focus).not.toHaveBeenCalled();

    rerender(<PromptInput value="" onChange={() => {}} onSubmit={() => {}} disabled={false} />);

    await waitFor(() => {
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    });
  });
});
