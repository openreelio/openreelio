import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AssistantArtifactGroup } from './AssistantArtifactGroup';

describe('AssistantArtifactGroup', () => {
  it('auto-collapses when streamed summary text arrives later', () => {
    const { rerender } = render(
      <AssistantArtifactGroup
        toolCallCount={1}
        toolResultCount={1}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts={false}
        hasFailedArtifacts={false}
        hasError={false}
        defaultOpen={true}
      >
        <div data-testid="artifact-child">artifact</div>
      </AssistantArtifactGroup>,
    );

    expect(screen.getByTestId('artifact-child')).toBeInTheDocument();

    rerender(
      <AssistantArtifactGroup
        toolCallCount={1}
        toolResultCount={1}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts={false}
        hasFailedArtifacts={false}
        hasError={false}
        defaultOpen={false}
      >
        <div data-testid="artifact-child">artifact</div>
      </AssistantArtifactGroup>,
    );

    expect(screen.queryByTestId('artifact-child')).not.toBeInTheDocument();
  });

  it('preserves a manual toggle when auto state changes later', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AssistantArtifactGroup
        toolCallCount={1}
        toolResultCount={1}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts={false}
        hasFailedArtifacts={false}
        hasError={false}
        defaultOpen={false}
      >
        <div data-testid="artifact-child">artifact</div>
      </AssistantArtifactGroup>,
    );

    expect(screen.queryByTestId('artifact-child')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('assistant-artifact-toggle'));
    expect(screen.getByTestId('artifact-child')).toBeInTheDocument();

    rerender(
      <AssistantArtifactGroup
        toolCallCount={1}
        toolResultCount={1}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts={false}
        hasFailedArtifacts={false}
        hasError={false}
        defaultOpen={false}
      >
        <div data-testid="artifact-child">artifact</div>
      </AssistantArtifactGroup>,
    );

    expect(screen.getByTestId('artifact-child')).toBeInTheDocument();
  });

  it('highlights focused artifacts without forcing inline details open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AssistantArtifactGroup
        toolCallCount={1}
        toolResultCount={1}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts={false}
        hasFailedArtifacts={false}
        hasError={false}
        defaultOpen={true}
        highlighted={false}
      >
        <div data-testid="artifact-child">artifact</div>
      </AssistantArtifactGroup>,
    );

    await user.click(screen.getByTestId('assistant-artifact-toggle'));
    expect(screen.queryByTestId('artifact-child')).not.toBeInTheDocument();

    rerender(
      <AssistantArtifactGroup
        toolCallCount={1}
        toolResultCount={1}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts={false}
        hasFailedArtifacts={false}
        hasError={false}
        defaultOpen={false}
        highlighted
      >
        <div data-testid="artifact-child">artifact</div>
      </AssistantArtifactGroup>,
    );

    expect(screen.queryByTestId('artifact-child')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-artifact-group')).toHaveClass('border-primary-500/40');
  });

  it('preserves manual collapse while artifacts are still running', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AssistantArtifactGroup
        toolCallCount={1}
        toolResultCount={0}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts
        hasFailedArtifacts={false}
        hasError={false}
        defaultOpen={true}
      >
        <div data-testid="artifact-child">artifact</div>
      </AssistantArtifactGroup>,
    );

    await user.click(screen.getByTestId('assistant-artifact-toggle'));
    expect(screen.queryByTestId('artifact-child')).not.toBeInTheDocument();

    rerender(
      <AssistantArtifactGroup
        toolCallCount={1}
        toolResultCount={0}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts
        hasFailedArtifacts={false}
        hasError={false}
        defaultOpen={true}
      >
        <div data-testid="artifact-child">artifact</div>
      </AssistantArtifactGroup>,
    );

    expect(screen.queryByTestId('artifact-child')).not.toBeInTheDocument();
  });

  it('constrains expanded details so large action logs do not take over the chat', async () => {
    const user = userEvent.setup();
    render(
      <AssistantArtifactGroup
        toolCallCount={40}
        toolResultCount={40}
        patchPartCount={0}
        patchFileCount={0}
        hasCompaction={false}
        hasRunningArtifacts
        hasFailedArtifacts
        hasError={false}
        defaultOpen={false}
      >
        {Array.from({ length: 80 }, (_, index) => (
          <div key={index}>artifact {index}</div>
        ))}
      </AssistantArtifactGroup>,
    );

    await user.click(screen.getByTestId('assistant-artifact-toggle'));

    expect(screen.getByTestId('assistant-artifact-group-body')).toHaveClass(
      'max-h-56',
      'overflow-y-auto',
    );
  });
});
