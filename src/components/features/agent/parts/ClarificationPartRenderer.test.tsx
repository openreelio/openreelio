import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClarificationPartRenderer } from './ClarificationPartRenderer';

describe('ClarificationPartRenderer', () => {
  it('renders the clarification question and guidance', () => {
    render(
      <ClarificationPartRenderer
        part={{
          type: 'clarification',
          question: 'Which clip should be used as the background?',
        }}
      />,
    );

    expect(screen.getByTestId('clarification-part')).toBeInTheDocument();
    expect(screen.getByText('Clarification Needed')).toBeInTheDocument();
    expect(screen.getByText('Which clip should be used as the background?')).toBeInTheDocument();
  });
});
