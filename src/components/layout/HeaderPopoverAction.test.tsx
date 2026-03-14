/**
 * HeaderPopoverAction Tests
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Terminal } from 'lucide-react';
import { HeaderPopoverAction } from './HeaderPopoverAction';

describe('HeaderPopoverAction', () => {
  it('should open the panel when the trigger is clicked', () => {
    render(
      <HeaderPopoverAction label="Console" icon={<Terminal className="h-4 w-4" />}>
        <div>Console Content</div>
      </HeaderPopoverAction>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Console/i }));

    expect(screen.getByRole('dialog', { name: /Console/i })).toBeInTheDocument();
    expect(screen.getByText('Console Content')).toBeInTheDocument();
  });

  it('should close the panel when escape is pressed', () => {
    render(
      <HeaderPopoverAction label="Console" icon={<Terminal className="h-4 w-4" />}>
        <div>Console Content</div>
      </HeaderPopoverAction>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Console/i }));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: /Console/i })).not.toBeInTheDocument();
  });

  it('should close the panel when clicking outside', () => {
    render(
      <div>
        <HeaderPopoverAction label="Console" icon={<Terminal className="h-4 w-4" />}>
          <div>Console Content</div>
        </HeaderPopoverAction>
        <button type="button">Outside</button>
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Console/i }));
    fireEvent.mouseDown(screen.getByRole('button', { name: /Outside/i }));

    expect(screen.queryByRole('dialog', { name: /Console/i })).not.toBeInTheDocument();
  });
});
