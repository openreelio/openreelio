import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SaveStatusBadge } from './SaveStatusBadge';

describe('SaveStatusBadge', () => {
  it('renders saving label', () => {
    render(<SaveStatusBadge status="saving" isDirty={true} />);

    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('renders saved label', () => {
    render(<SaveStatusBadge status="saved" isDirty={true} />);

    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('renders error label', () => {
    render(<SaveStatusBadge status="error" isDirty={true} />);

    expect(screen.getByText('Save failed')).toBeInTheDocument();
  });

  it('renders unsaved label when idle and dirty', () => {
    render(<SaveStatusBadge status="idle" isDirty={true} />);

    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('renders nothing when idle and clean', () => {
    const { container } = render(<SaveStatusBadge status="idle" isDirty={false} />);

    expect(container).toBeEmptyDOMElement();
  });
});
