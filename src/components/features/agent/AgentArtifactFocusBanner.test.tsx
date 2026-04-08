import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentArtifactFocusBanner } from './AgentArtifactFocusBanner';

describe('AgentArtifactFocusBanner', () => {
  it('renders updated labels for file and summary focus states', () => {
    const { rerender } = render(
      <AgentArtifactFocusBanner focus={{ kind: 'file', value: 'src/foo.ts' }} onClear={vi.fn()} />,
    );

    expect(screen.getByText('Showing file changes: src/foo.ts')).toBeInTheDocument();

    rerender(<AgentArtifactFocusBanner focus={{ kind: 'summary' }} onClear={vi.fn()} />);

    expect(screen.getByText('Showing earlier context')).toBeInTheDocument();
  });

  it('renders tool focus text and clears on click', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();

    render(
      <AgentArtifactFocusBanner focus={{ kind: 'tool', value: 'delete_clip' }} onClear={onClear} />,
    );

    expect(screen.getByText('Showing action details: delete_clip')).toBeInTheDocument();

    await user.click(screen.getByTestId('agent-artifact-focus-clear-btn'));

    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
