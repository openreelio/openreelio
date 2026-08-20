/**
 * TransformOverlay
 *
 * Public entry point for the preview transform overlay. The implementation
 * lives in `MoveableTransformOverlay`, the project-owned facade around
 * react-moveable; this module keeps the historical name, props and import path
 * stable for the three preview players that render it.
 */

export type { TransformOverlayProps } from './MoveableTransformOverlay';
export { MoveableTransformOverlay as TransformOverlay } from './MoveableTransformOverlay';
