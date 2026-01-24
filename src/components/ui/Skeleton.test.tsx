import { render, screen } from '@testing-library/react';
import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('renders with default base classes', () => {
    render(<Skeleton data-testid="skeleton" />);
    const skeleton = screen.getByTestId('skeleton');

    expect(skeleton).toBeInTheDocument();
    // Check for base classes that should always be present
    expect(skeleton).toHaveClass('animate-pulse');
    expect(skeleton).toHaveClass('rounded-md');
    expect(skeleton).toHaveClass('bg-gray-700'); // Assuming gray-700/muted equivalent
  });

  it('merges custom classNames', () => {
    render(<Skeleton className="w-20 h-20 rounded-full" data-testid="skeleton" />);
    const skeleton = screen.getByTestId('skeleton');

    expect(skeleton).toHaveClass('w-20');
    expect(skeleton).toHaveClass('h-20');
    expect(skeleton).toHaveClass('rounded-full');
    expect(skeleton).toHaveClass('animate-pulse'); // Base class should still be there
  });
});
