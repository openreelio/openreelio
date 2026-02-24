import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PatchPartRenderer } from './PatchPartRenderer';
import type { PatchPart } from '@/agents/engine/core/conversation';

describe('PatchPartRenderer', () => {
  const singleFilePart: PatchPart = {
    type: 'patch',
    diff: `--- a/src/main.ts
+++ b/src/main.ts
@@ -10,7 +10,7 @@
 function main() {
-  console.log('old');
+  console.log('new');
 }`,
    files: ['src/main.ts'],
  };

  const multiFilePart: PatchPart = {
    type: 'patch',
    diff: `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 export { a };
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-const x = 'old';
+const x = 'new';`,
    files: ['src/a.ts', 'src/b.ts'],
  };

  it('should render expanded by default', () => {
    render(<PatchPartRenderer part={singleFilePart} />);
    expect(screen.getByTestId('patch-part')).toBeInTheDocument();
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('should show single filename for single file', () => {
    render(<PatchPartRenderer part={singleFilePart} />);
    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
  });

  it('should show file count for multiple files', () => {
    render(<PatchPartRenderer part={multiFilePart} />);
    expect(screen.getByText('2 files')).toBeInTheDocument();
  });

  it('should show addition and deletion counts', () => {
    render(<PatchPartRenderer part={singleFilePart} />);
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
  });

  it('should render diff lines with correct content', () => {
    render(<PatchPartRenderer part={singleFilePart} />);
    expect(screen.getByText(/console\.log\('new'\)/)).toBeInTheDocument();
  });

  it('should collapse on click', async () => {
    const user = userEvent.setup();
    render(<PatchPartRenderer part={singleFilePart} />);

    const button = screen.getByRole('button');
    await user.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('should apply custom className', () => {
    render(<PatchPartRenderer part={singleFilePart} className="mt-2" />);
    expect(screen.getByTestId('patch-part')).toHaveClass('mt-2');
  });
});
