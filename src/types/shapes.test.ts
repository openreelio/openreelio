import { describe, it, expect } from 'vitest';
import {
  createRectangle,
  createCircle,
  createPolygon,
  createLine,
  lowerThirdBar,
  calloutBox,
  highlightCircle,
  arrowPointer,
  dividerLine,
  solidFill,
  noFill,
  isValidHexColor,
  validateShapeLayerData,
  DEFAULT_STROKE,
  CENTER_POSITION,
} from './shapes';

describe('Shape types', () => {
  describe('factory functions', () => {
    it('should create rectangle with defaults', () => {
      const rect = createRectangle();
      expect(rect.shape.type).toBe('rectangle');
      expect(rect.name).toBe('Rectangle');
    });

    it('should create rectangle with custom values', () => {
      const rect = createRectangle(0.5, 0.4, 0.1);
      expect(rect.shape.type).toBe('rectangle');
      if (rect.shape.type === 'rectangle') {
        expect(rect.shape.width).toBe(0.5);
        expect(rect.shape.height).toBe(0.4);
        expect(rect.shape.cornerRadius).toBe(0.1);
      }
    });

    it('should create circle', () => {
      const circle = createCircle(0.15);
      expect(circle.shape.type).toBe('ellipse');
      if (circle.shape.type === 'ellipse') {
        expect(circle.shape.radiusX).toBe(0.15);
        expect(circle.shape.radiusY).toBe(0.15);
      }
    });

    it('should create circle with default radius', () => {
      const circle = createCircle();
      expect(circle.shape.type).toBe('ellipse');
      if (circle.shape.type === 'ellipse') {
        expect(circle.shape.radiusX).toBe(0.15);
        expect(circle.shape.radiusY).toBe(0.15);
      }
    });

    it('should create polygon', () => {
      const hex = createPolygon(6, 0.2);
      expect(hex.shape.type).toBe('polygon');
      if (hex.shape.type === 'polygon') {
        expect(hex.shape.sides).toBe(6);
        expect(hex.shape.radius).toBe(0.2);
      }
    });

    it('should create polygon with default values', () => {
      const hex = createPolygon();
      expect(hex.shape.type).toBe('polygon');
      if (hex.shape.type === 'polygon') {
        expect(hex.shape.sides).toBe(6);
        expect(hex.shape.radius).toBe(0.15);
      }
      expect(hex.name).toBe('6-sided Polygon');
    });

    it('should create line', () => {
      const line = createLine(0.1, 0.2, 0.9, 0.8);
      expect(line.shape.type).toBe('line');
      if (line.shape.type === 'line') {
        expect(line.shape.startX).toBe(0.1);
        expect(line.shape.startY).toBe(0.2);
        expect(line.shape.endX).toBe(0.9);
        expect(line.shape.endY).toBe(0.8);
      }
    });

    it('should create line with defaults', () => {
      const line = createLine();
      expect(line.shape.type).toBe('line');
      expect(line.stroke.width).toBe(4);
      expect(line.fill.type).toBe('none');
    });
  });

  describe('preset shapes', () => {
    it('should create lower third bar', () => {
      const bar = lowerThirdBar();
      expect(bar.position.y).toBe(0.88);
      expect(bar.name).toBe('Lower Third Bar');
      if (bar.shape.type === 'rectangle') {
        expect(bar.shape.width).toBe(1.0);
        expect(bar.shape.height).toBe(0.12);
      }
    });

    it('should create callout box', () => {
      const box = calloutBox();
      expect(box.stroke.width).toBe(2);
      expect(box.stroke.color).toBe('#333333');
      expect(box.name).toBe('Callout Box');
    });

    it('should create highlight circle', () => {
      const circle = highlightCircle();
      expect(circle.fill.type).toBe('none');
      expect(circle.stroke.color).toBe('#FF0000');
      expect(circle.stroke.width).toBe(4);
      expect(circle.name).toBe('Highlight Circle');
    });

    it('should create arrow pointer', () => {
      const arrow = arrowPointer();
      expect(arrow.shape.type).toBe('polygon');
      if (arrow.shape.type === 'polygon') {
        expect(arrow.shape.sides).toBe(3);
        expect(arrow.shape.rotationOffset).toBe(90);
      }
      expect(arrow.name).toBe('Arrow');
    });

    it('should create divider line', () => {
      const divider = dividerLine();
      expect(divider.shape.type).toBe('line');
      expect(divider.stroke.color).toBe('#CCCCCC');
      expect(divider.name).toBe('Divider');
    });
  });

  describe('fill helpers', () => {
    it('should create solid fill', () => {
      const fill = solidFill('#FF0000');
      expect(fill.type).toBe('solid');
      if (fill.type === 'solid') {
        expect(fill.color).toBe('#FF0000');
      }
    });

    it('should create no fill', () => {
      const fill = noFill();
      expect(fill.type).toBe('none');
    });
  });

  describe('validation', () => {
    it('should validate hex colors - 3 digit', () => {
      expect(isValidHexColor('#FFF')).toBe(true);
      expect(isValidHexColor('#abc')).toBe(true);
    });

    it('should validate hex colors - 6 digit', () => {
      expect(isValidHexColor('#FFFFFF')).toBe(true);
      expect(isValidHexColor('#123456')).toBe(true);
    });

    it('should validate hex colors - 8 digit with alpha', () => {
      expect(isValidHexColor('#FF0000CC')).toBe(true);
      expect(isValidHexColor('#00000080')).toBe(true);
    });

    it('should validate hex colors - 4 digit with alpha', () => {
      expect(isValidHexColor('#FFFA')).toBe(true);
    });

    it('should reject invalid hex colors', () => {
      expect(isValidHexColor('red')).toBe(false);
      expect(isValidHexColor('#GGG')).toBe(false);
      expect(isValidHexColor('FFFFFF')).toBe(false);
      expect(isValidHexColor('#FF')).toBe(false);
    });

    it('should validate shape layer data - valid', () => {
      const valid = createRectangle();
      expect(validateShapeLayerData(valid)).toEqual([]);
    });

    it('should validate shape layer data - invalid opacity', () => {
      const invalid = { ...createRectangle(), opacity: 2 };
      const errors = validateShapeLayerData(invalid);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes('Opacity'))).toBe(true);
    });

    it('should validate shape layer data - invalid position', () => {
      const invalid = {
        ...createRectangle(),
        position: { x: 1.5, y: -0.1 },
      };
      const errors = validateShapeLayerData(invalid);
      expect(errors.length).toBe(2);
      expect(errors.some((e) => e.includes('Position X'))).toBe(true);
      expect(errors.some((e) => e.includes('Position Y'))).toBe(true);
    });

    it('should validate shape layer data - invalid stroke width', () => {
      const invalid = {
        ...createRectangle(),
        stroke: { ...DEFAULT_STROKE, width: 150 },
      };
      const errors = validateShapeLayerData(invalid);
      expect(errors.some((e) => e.includes('Stroke width'))).toBe(true);
    });

    it('should validate shape layer data - invalid stroke color', () => {
      const invalid = {
        ...createRectangle(),
        stroke: { ...DEFAULT_STROKE, color: 'invalid' },
      };
      const errors = validateShapeLayerData(invalid);
      expect(errors.some((e) => e.includes('stroke color'))).toBe(true);
    });

    it('should validate shape layer data - invalid fill color', () => {
      const invalid = {
        ...createRectangle(),
        fill: { type: 'solid' as const, color: 'not-a-color' },
      };
      const errors = validateShapeLayerData(invalid);
      expect(errors.some((e) => e.includes('fill color'))).toBe(true);
    });
  });

  describe('constants', () => {
    it('should have default stroke', () => {
      expect(DEFAULT_STROKE.color).toBe('#FFFFFF');
      expect(DEFAULT_STROKE.width).toBe(2);
      expect(DEFAULT_STROKE.cap).toBe('round');
      expect(DEFAULT_STROKE.join).toBe('round');
      expect(DEFAULT_STROKE.dashPattern).toEqual([]);
    });

    it('should have center position', () => {
      expect(CENTER_POSITION.x).toBe(0.5);
      expect(CENTER_POSITION.y).toBe(0.5);
    });
  });
});
