/**
 * MaskShapeTools Component
 *
 * Toolbar for selecting mask drawing tools (select, rectangle, ellipse, polygon, bezier).
 *
 * @module components/features/masks/MaskShapeTools
 */

import React, { useCallback } from 'react';
import { MousePointer2, Square, Circle, Triangle, Spline } from 'lucide-react';
import type { MaskTool } from '@/hooks/useMaskEditor';

// =============================================================================
// Types
// =============================================================================

export interface MaskShapeToolsProps {
  /** Currently active tool */
  activeTool: MaskTool;
  /** Called when tool is changed */
  onToolChange: (tool: MaskTool) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Compact mode (smaller buttons) */
  compact?: boolean;
  /** Layout orientation */
  orientation?: 'horizontal' | 'vertical';
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

interface ToolConfig {
  id: MaskTool;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
}

const TOOL_CONFIGS: ToolConfig[] = [
  {
    id: 'select',
    label: 'Select',
    icon: <MousePointer2 size={16} />,
    shortcut: 'V',
  },
  {
    id: 'rectangle',
    label: 'Rectangle',
    icon: <Square size={16} />,
    shortcut: 'R',
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    icon: <Circle size={16} />,
    shortcut: 'E',
  },
  {
    id: 'polygon',
    label: 'Polygon',
    icon: <Triangle size={16} />,
    shortcut: 'P',
  },
  {
    id: 'bezier',
    label: 'Bezier',
    icon: <Spline size={16} />,
    shortcut: 'B',
  },
];

// =============================================================================
// Component
// =============================================================================

export function MaskShapeTools({
  activeTool,
  onToolChange,
  disabled = false,
  compact = false,
  orientation = 'horizontal',
  className = '',
}: MaskShapeToolsProps) {
  // Handle tool click
  const handleToolClick = useCallback(
    (tool: MaskTool) => {
      if (!disabled) {
        onToolChange(tool);
      }
    },
    [disabled, onToolChange]
  );

  // Container classes
  const containerClasses = [
    'flex items-center',
    orientation === 'horizontal' ? 'flex-row' : 'flex-col',
    compact ? 'gap-0.5' : 'gap-1',
    'p-1',
    'bg-zinc-800/50',
    'rounded-lg',
    'border border-zinc-700',
    disabled ? 'opacity-50' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Button classes
  const getButtonClasses = (tool: MaskTool) => {
    const isActive = tool === activeTool;
    const baseClasses = [
      'flex items-center justify-center',
      compact ? 'w-7 h-7' : 'w-8 h-8',
      'rounded',
      'transition-colors',
      'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-zinc-900',
    ];

    const stateClasses = isActive
      ? ['bg-blue-600', 'text-white']
      : ['text-zinc-400', 'hover:text-white', 'hover:bg-zinc-700'];

    const disabledClasses = disabled
      ? ['cursor-not-allowed', 'opacity-50']
      : ['cursor-pointer'];

    return [...baseClasses, ...stateClasses, ...disabledClasses].join(' ');
  };

  return (
    <div data-testid="mask-shape-tools" className={containerClasses}>
      {TOOL_CONFIGS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          onClick={() => handleToolClick(tool.id)}
          disabled={disabled}
          className={getButtonClasses(tool.id)}
          aria-label={tool.label}
          aria-pressed={tool.id === activeTool}
          title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
        >
          {tool.icon}
        </button>
      ))}
    </div>
  );
}

export default MaskShapeTools;
