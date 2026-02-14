import { useCallback, useEffect, useState } from 'react';

interface UseResponsiveSidebarStateOptions {
  autoCollapseBreakpoint: number;
  initialCollapsed?: boolean;
  initialWidth?: number;
}

interface ResponsiveSidebarState {
  collapsed: boolean;
  width: number;
  setCollapsed: (collapsed: boolean) => void;
  setWidth: (width: number) => void;
  toggleCollapsed: () => void;
}

export function useResponsiveSidebarState({
  autoCollapseBreakpoint,
  initialCollapsed = false,
  initialWidth = 320,
}: UseResponsiveSidebarStateOptions): ResponsiveSidebarState {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [width, setWidth] = useState(initialWidth);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => !current);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleResize = () => {
      if (window.innerWidth < autoCollapseBreakpoint) {
        setCollapsed(true);
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [autoCollapseBreakpoint]);

  return {
    collapsed,
    width,
    setCollapsed,
    setWidth,
    toggleCollapsed,
  };
}
