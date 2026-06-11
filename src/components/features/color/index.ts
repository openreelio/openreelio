/**
 * Color Feature Components
 *
 * Professional color correction tools: RGB curves, advanced curves
 * (Hue vs Hue, Hue vs Sat, Luma vs Sat), temperature/tint controls,
 * and before/after comparison overlay.
 */

// Color Curves Editor
export { ColorCurvesPanel } from './ColorCurvesPanel';
export type { ColorCurvesPanelProps } from './ColorCurvesPanel';

// Temperature / Tint Controls
export { TemperatureTintPanel } from './TemperatureTintPanel';
export type { TemperatureTintPanelProps } from './TemperatureTintPanel';

// LUT Controls
export { LutPanel } from './LutPanel';
export type { LutPanelProps, LutInterpolation } from './LutPanel';

// Before/After Color Comparison
export { ColorComparisonOverlay } from './ColorComparisonOverlay';
export type { ColorComparisonOverlayProps } from './ColorComparisonOverlay';

// Power Windows (Mask + Color Correction)
export { PowerWindowSection } from './PowerWindowSection';
export type { PowerWindowSectionProps } from './PowerWindowSection';

// Color Match (Auto Shot Matching)
export { ColorMatchSection } from './ColorMatchSection';
export type { ColorMatchSectionProps } from './ColorMatchSection';
