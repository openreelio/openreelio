import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentArtifactFocusBanner } from './AgentArtifactFocusBanner';

describe('AgentArtifactFocusBanner', () => {
  it('renders tool focus text and clears on click', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();

    render(
      <AgentArtifactFocusBanner focus={{ kind: 'tool', value: 'delete_clip' }} onClear={onClear} />,
    );

    expect(screen.getByText('Focused tool output: delete_clip')).toBeInTheDocument();

    await user.click(screen.getByTestId('agent-artifact-focus-clear-btn'));

    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
