/**
 * Shape Layer Types
 *
 * TypeScript types for shape layers in video editing.
 * These types match the Rust types in src-tauri/src/core/shapes/mod.rs.
 */

// =============================================================================
// Shape Types
// =============================================================================

/** Rectangle shape data */
export interface RectangleShape {
  /** Width as fraction of video width (0.0-1.0) */
  width: number;
  /** Height as fraction of video height (0.0-1.0) */
  height: number;
  /** Corner radius as fraction of minimum(width, height) (0.0-0.5) */
  cornerRadius?: number;
}

/** Ellipse/circle shape data */
export interface EllipseShape {
  /** Horizontal radius as fraction of video width */
  radiusX: number;
  /** Vertical radius as fraction of video height */
  radiusY: number;
}

/** Line shape data */
export interface LineShape {
  /** Start point X (normalized) */
  startX: number;
  /** Start point Y (normalized) */
  startY: number;
  /** End point X (normalized) */
  endX: number;
  /** End point Y (normalized) */
  endY: number;
}

/** Regular polygon shape data */
export interface PolygonShape {
  /** Number of sides (3 = triangle, 5 = pentagon, etc.) */
  sides: number;
  /** Radius as fraction of video dimensions */
  radius: number;
  /** Rotation offset in degrees */
  rotationOffset?: number;
}

/** Point in a path */
export interface PathPoint {
  /** X coordinate (normalized) */
  x: number;
  /** Y coordinate (normalized) */
  y: number;
  /** Control point 1 X offset (for curves) */
  cp1X?: number;
  /** Control point 1 Y offset */
  cp1Y?: number;
  /** Control point 2 X offset (for curves) */
  cp2X?: number;
  /** Control point 2 Y offset */
  cp2Y?: number;
}

/** Custom bezier path shape */
export interface PathShape {
  /** Path points */
  points: PathPoint[];
  /** Whether the path is closed */
  closed?: boolean;
}

/** Discriminated union for shape types */
export type ShapeType =
  | { type: 'rectangle' } & RectangleShape
  | { type: 'ellipse' } & EllipseShape
  | { type: 'line' } & LineShape
  | { type: 'polygon' } & PolygonShape
  | { type: 'path' } & PathShape;

// =============================================================================
// Shape Fill
// =============================================================================

/** Shape fill style - discriminated union */
export type ShapeFill =
  | { type: 'none' }
  | { type: 'solid'; color: string }
  | { type: 'linearGradient'; colorStart: string; colorEnd: string; angle: number }
  | { type: 'radialGradient'; colorCenter: string; colorEdge: string };

// =============================================================================
// Shape Stroke
// =============================================================================

/** Line cap style */
export type StrokeCap = 'butt' | 'round' | 'square';

/** Line join style */
export type StrokeJoin = 'miter' | 'round' | 'bevel';

/** Shape stroke (outline) style */
export interface ShapeStroke {
  /** Stroke color in hex format */
  color: string;
  /** Stroke width in pixels */
  width: number;
  /** Line cap style */
  cap?: StrokeCap;
  /** Line join style */
  join?: StrokeJoin;
  /** Dash pattern (empty = solid line) */
  dashPattern?: number[];
}

// =============================================================================
// Shape Position
// =============================================================================

/** Shape position using normalized coordinates */
export interface ShapePosition {
  /** X position (0.0 = left, 0.5 = center, 1.0 = right) */
  x: number;
  /** Y position (0.0 = top, 0.5 = center, 1.0 = bottom) */
  y: number;
}

// =============================================================================
// Shape Layer Data
// =============================================================================

/** Complete shape layer configuration */
export interface ShapeLayerData {
  /** The shape geometry */
  shape: ShapeType;
  /** Fill style */
  fill: ShapeFill;
  /** Stroke style */
  stroke: ShapeStroke;
  /** Position on screen (center point) */
  position: ShapePosition;
  /** Rotation in degrees */
  rotation?: number;
  /** Opacity (0.0-1.0) */
  opacity?: number;
  /** Layer name for UI */
  name?: string;
}

// =============================================================================
// Factory Functions
// =============================================================================

/** Creates a default rectangle shape */
export function createRectangleShape(
  width = 0.3,
  height = 0.2,
  cornerRadius = 0
): ShapeType {
  return {
    type: 'rectangle',
    width,
    height,
    cornerRadius,
  };
}

/** Creates a default ellipse shape */
export function createEllipseShape(radiusX = 0.15, radiusY = 0.15): ShapeType {
  return {
    type: 'ellipse',
    radiusX,
    radiusY,
  };
}

/** Creates a circle shape */
export function createCircleShape(radius = 0.15): ShapeType {
  return createEllipseShape(radius, radius);
}

/** Creates a default line shape */
export function createLineShape(
  startX = 0.2,
  startY = 0.5,
  endX = 0.8,
  endY = 0.5
): ShapeType {
  return {
    type: 'line',
    startX,
    startY,
    endX,
    endY,
  };
}

/** Creates a polygon shape */
export function createPolygonShape(sides = 6, radius = 0.15): ShapeType {
  return {
    type: 'polygon',
    sides,
    radius,
  };
}

/** Creates a solid fill */
export function createSolidFill(color: string): ShapeFill {
  return { type: 'solid', color };
}

/** Creates no fill (transparent) */
export function createNoFill(): ShapeFill {
  return { type: 'none' };
}

/** Creates a linear gradient fill */
export function createLinearGradientFill(
  colorStart: string,
  colorEnd: string,
  angle = 0
): ShapeFill {
  return { type: 'linearGradient', colorStart, colorEnd, angle };
}

/** Creates a stroke */
export function createStroke(color: string, width: number): ShapeStroke {
  return { color, width, cap: 'round', join: 'round' };
}

/** Creates no stroke (invisible) */
export function createNoStroke(): ShapeStroke {
  return { color: '#000000', width: 0 };
}

/** Creates a default shape layer */
export function createShapeLayerData(shape: ShapeType): ShapeLayerData {
  return {
    shape,
    fill: createSolidFill('#3366CC'),
    stroke: createStroke('#FFFFFF', 2),
    position: { x: 0.5, y: 0.5 },
    rotation: 0,
    opacity: 1.0,
    name: 'Shape',
  };
}

/** Creates a rectangle shape layer */
export function createRectangleLayer(
  width = 0.3,
  height = 0.2
): ShapeLayerData {
  return createShapeLayerData(createRectangleShape(width, height));
}

/** Creates a circle shape layer */
export function createCircleLayer(radius = 0.15): ShapeLayerData {
  return createShapeLayerData(createCircleShape(radius));
}

// =============================================================================
// Defaults and Presets
// =============================================================================

/** Default stroke configuration */
export const DEFAULT_STROKE: ShapeStroke = {
  color: '#FFFFFF',
  width: 2,
  cap: 'round',
  join: 'round',
  dashPattern: [],
};

/** No stroke (transparent) */
export const NO_STROKE: ShapeStroke = {
  color: '#FFFFFF',
  width: 0,
  cap: 'round',
  join: 'round',
  dashPattern: [],
};

/** Default position (center) */
export const CENTER_POSITION: ShapePosition = { x: 0.5, y: 0.5 };

/** Create solid fill */
export function solidFill(color: string): ShapeFill {
  return { type: 'solid', color };
}

/** Create no fill */
export function noFill(): ShapeFill {
  return { type: 'none' };
}

/** Create linear gradient fill */
export function linearGradientFill(
  colorStart: string,
  colorEnd: string,
  angle = 0
): ShapeFill {
  return { type: 'linearGradient', colorStart, colorEnd, angle };
}

/** Create radial gradient fill */
export function radialGradientFill(
  colorCenter: string,
  colorEdge: string
): ShapeFill {
  return { type: 'radialGradient', colorCenter, colorEdge };
}

// =============================================================================
// Additional Shape Factory Functions
// =============================================================================

/** Create a rectangle shape layer */
export function createRectangle(
  width = 0.3,
  height = 0.2,
  cornerRadius = 0
): ShapeLayerData {
  return {
    shape: { type: 'rectangle', width, height, cornerRadius },
    fill: solidFill('#FFFFFF'),
    stroke: NO_STROKE,
    position: CENTER_POSITION,
    rotation: 0,
    opacity: 1,
    name: 'Rectangle',
  };
}

/** Create a circle shape layer */
export function createCircle(radius = 0.15): ShapeLayerData {
  return {
    shape: { type: 'ellipse', radiusX: radius, radiusY: radius },
    fill: solidFill('#FFFFFF'),
    stroke: NO_STROKE,
    position: CENTER_POSITION,
    rotation: 0,
    opacity: 1,
    name: 'Circle',
  };
}

/** Create a polygon shape layer */
export function createPolygon(sides = 6, radius = 0.15): ShapeLayerData {
  return {
    shape: { type: 'polygon', sides, radius, rotationOffset: 0 },
    fill: solidFill('#FFFFFF'),
    stroke: NO_STROKE,
    position: CENTER_POSITION,
    rotation: 0,
    opacity: 1,
    name: `${sides}-sided Polygon`,
  };
}

/** Create a line shape layer */
export function createLine(
  startX = 0.2,
  startY = 0.5,
  endX = 0.8,
  endY = 0.5
): ShapeLayerData {
  return {
    shape: { type: 'line', startX, startY, endX, endY },
    fill: noFill(),
    stroke: { ...DEFAULT_STROKE, width: 4 },
    position: CENTER_POSITION,
    rotation: 0,
    opacity: 1,
    name: 'Line',
  };
}

// =============================================================================
// Preset Shapes
// =============================================================================

/** Lower third bar preset */
export function lowerThirdBar(): ShapeLayerData {
  return {
    shape: { type: 'rectangle', width: 1.0, height: 0.12, cornerRadius: 0 },
    fill: solidFill('#000000CC'),
    stroke: NO_STROKE,
    position: { x: 0.5, y: 0.88 },
    rotation: 0,
    opacity: 1,
    name: 'Lower Third Bar',
  };
}

/** Callout box preset */
export function calloutBox(): ShapeLayerData {
  return {
    shape: { type: 'rectangle', width: 0.3, height: 0.15, cornerRadius: 0.02 },
    fill: solidFill('#FFFFFF'),
    stroke: { ...DEFAULT_STROKE, color: '#333333', width: 2 },
    position: CENTER_POSITION,
    rotation: 0,
    opacity: 1,
    name: 'Callout Box',
  };
}

/** Highlight circle preset */
export function highlightCircle(): ShapeLayerData {
  return {
    shape: { type: 'ellipse', radiusX: 0.1, radiusY: 0.1 },
    fill: noFill(),
    stroke: { ...DEFAULT_STROKE, color: '#FF0000', width: 4 },
    position: CENTER_POSITION,
    rotation: 0,
    opacity: 1,
    name: 'Highlight Circle',
  };
}

/** Arrow pointer preset */
export function arrowPointer(): ShapeLayerData {
  return {
    shape: { type: 'polygon', sides: 3, radius: 0.08, rotationOffset: 90 },
    fill: solidFill('#FF6600'),
    stroke: NO_STROKE,
    position: CENTER_POSITION,
    rotation: 0,
    opacity: 1,
    name: 'Arrow',
  };
}

/** Divider line preset */
export function dividerLine(): ShapeLayerData {
  return {
    shape: { type: 'line', startX: 0.1, startY: 0.5, endX: 0.9, endY: 0.5 },
    fill: noFill(),
    stroke: { ...DEFAULT_STROKE, color: '#CCCCCC', width: 2 },
    position: CENTER_POSITION,
    rotation: 0,
    opacity: 1,
    name: 'Divider',
  };
}

// =============================================================================
// Validation
// =============================================================================

/** Validate hex color format */
export function isValidHexColor(color: string): boolean {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(color);
}

/** Validate shape layer data */
export function validateShapeLayerData(data: ShapeLayerData): string[] {
  const errors: string[] = [];

  // Validate position
  if (data.position.x < 0 || data.position.x > 1) {
    errors.push('Position X must be between 0 and 1');
  }
  if (data.position.y < 0 || data.position.y > 1) {
    errors.push('Position Y must be between 0 and 1');
  }

  // Validate opacity
  const opacity = data.opacity ?? 1;
  if (opacity < 0 || opacity > 1) {
    errors.push('Opacity must be between 0 and 1');
  }

  // Validate stroke
  if (data.stroke.width < 0 || data.stroke.width > 100) {
    errors.push('Stroke width must be between 0 and 100');
  }
  if (!isValidHexColor(data.stroke.color)) {
    errors.push('Invalid stroke color format');
  }

  // Validate fill color if solid
  if (data.fill.type === 'solid' && !isValidHexColor(data.fill.color)) {
    errors.push('Invalid fill color format');
  }

  return errors;
}
