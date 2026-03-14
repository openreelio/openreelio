/**
 * HeaderPopoverAction Component
 *
 * A compact header action that reveals a utility panel on demand.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

// =============================================================================
// Types
// =============================================================================

interface HeaderPopoverActionProps {
  /** Button label */
  label: string;
  /** Button icon */
  icon: ReactNode;
  /** Panel content */
  children: ReactNode;
  /** Panel alignment relative to the button */
  align?: 'left' | 'right';
  /** Additional button classes */
  buttonClassName?: string;
  /** Additional panel classes */
  panelClassName?: string;
}

// =============================================================================
// Component
// =============================================================================

export function HeaderPopoverAction({
  label,
  icon,
  children,
  align = 'right',
  buttonClassName = '',
  panelClassName = '',
}: HeaderPopoverActionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const alignmentClass = align === 'left' ? 'left-0' : 'right-0';

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className={`flex items-center gap-2 rounded-lg border border-border-default bg-surface-panel px-2 py-1.5 text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary sm:px-3 ${buttonClassName}`}
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title={label}
      >
        {icon}
        <span className="hidden text-sm sm:inline">{label}</span>
      </button>

      {isOpen && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={`absolute ${alignmentClass} top-full z-50 mt-2 w-[320px] max-w-[90vw] overflow-hidden rounded-xl border border-border-default bg-editor-panel shadow-2xl ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
