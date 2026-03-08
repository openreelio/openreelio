/**
 * PacingCurveChart Component
 *
 * Canvas2D overlay line chart that visualizes reference vs. output pacing curves.
 * Draws normalized shot duration curves with correlation display.
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import type { ComparisonCurvePoint } from '@/utils/referenceComparison';

/** A single point on a pacing curve */
export type PacingDataPoint = ComparisonCurvePoint;

/** Props for the PacingCurveChart component */
export interface PacingCurveChartProps {
  /** Reference pacing curve from ESD */
  referenceCurve: PacingDataPoint[];
  /** Current timeline output pacing curve */
  outputCurve: PacingDataPoint[];
  /** Pearson correlation coefficient (-1 to 1) */
  correlation: number;
  /** Canvas width in pixels */
  width?: number;
  /** Canvas height in pixels */
  height?: number;
  /** Optional CSS class name */
  className?: string;
}

const PAD = { top: 20, right: 60, bottom: 30, left: 40 };
const REF_COLOR = 'rgb(56, 189, 248)';
const OUT_COLOR = 'rgb(251, 146, 60)';
const GRID_COLOR = 'rgba(255, 255, 255, 0.08)';
const AXIS_COLOR = 'rgba(255, 255, 255, 0.25)';
const TEXT_COLOR = 'rgba(255, 255, 255, 0.5)';
const DIVS = 4;

function drawCurve(
  ctx: CanvasRenderingContext2D,
  pts: PacingDataPoint[],
  px: number,
  py: number,
  pw: number,
  ph: number,
  maxVal: number,
  color: string,
  dashed: boolean,
): void {
  if (pts.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dashed ? [6, 4] : []);
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = px + pts[i].time * pw;
    const y = py + ph - (maxVal > 0 ? pts[i].value / maxVal : 0) * ph;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

export const PacingCurveChart = memo(function PacingCurveChart({
  referenceCurve,
  outputCurve,
  correlation,
  width = 400,
  height = 200,
  className = '',
}: PacingCurveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const px = PAD.left,
      py = PAD.top;
    const pw = width - PAD.left - PAD.right;
    const ph = height - PAD.top - PAD.bottom;

    // Empty state
    if (referenceCurve.length === 0 && outputCurve.length === 0) {
      ctx.fillStyle = TEXT_COLOR;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No pacing data available', width / 2, height / 2);
      return;
    }

    // Normalize each curve independently to 0..1 range so both use the same visual scale
    const refMax = Math.max(...referenceCurve.map((p) => p.value), 0.001);
    const outMax = Math.max(...outputCurve.map((p) => p.value), 0.001);
    const normalizedRef = referenceCurve.map((p) => ({ ...p, value: p.value / refMax }));
    const normalizedOut = outputCurve.map((p) => ({ ...p, value: p.value / outMax }));
    const maxVal = 1;

    // Grid
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    for (let i = 0; i <= DIVS; i++) {
      const gy = py + (ph / DIVS) * i;
      ctx.beginPath();
      ctx.moveTo(px, gy);
      ctx.lineTo(px + pw, gy);
      ctx.stroke();
      const gx = px + (pw / DIVS) * i;
      ctx.beginPath();
      ctx.moveTo(gx, py);
      ctx.lineTo(gx, py + ph);
      ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = AXIS_COLOR;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px, py + ph);
    ctx.lineTo(px + pw, py + ph);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Timeline Position', px + pw / 2, height - 4);
    ctx.save();
    ctx.translate(10, py + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Duration', 0, 0);
    ctx.restore();

    // Curves
    drawCurve(ctx, normalizedRef, px, py, pw, ph, maxVal, REF_COLOR, false);
    drawCurve(ctx, normalizedOut, px, py, pw, ph, maxVal, OUT_COLOR, true);

    // Correlation badge
    const pct = Math.round(correlation * 100);
    const label = `r = ${pct}%`;
    ctx.font = 'bold 11px sans-serif';
    const bw = ctx.measureText(label).width + 12;
    const bx = width - PAD.right + 4,
      by = PAD.top;
    const good = correlation >= 0.7;
    const inverse = correlation < 0;
    ctx.fillStyle = good
      ? 'rgba(34, 197, 94, 0.2)'
      : inverse
        ? 'rgba(248, 113, 113, 0.2)'
        : 'rgba(250, 204, 21, 0.2)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, 20, 4);
    ctx.fill();
    ctx.fillStyle = good
      ? 'rgb(34, 197, 94)'
      : inverse
        ? 'rgb(248, 113, 113)'
        : 'rgb(250, 204, 21)';
    ctx.textAlign = 'left';
    ctx.fillText(label, bx + 6, by + 14);

    // Legend
    const ly = PAD.top + 30;
    ctx.font = '10px sans-serif';
    ctx.strokeStyle = REF_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(bx, ly + 6);
    ctx.lineTo(bx + 16, ly + 6);
    ctx.stroke();
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText('Ref', bx + 20, ly + 10);
    ctx.strokeStyle = OUT_COLOR;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(bx, ly + 22);
    ctx.lineTo(bx + 16, ly + 22);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText('Out', bx + 20, ly + 26);
  }, [referenceCurve, outputCurve, correlation, width, height]);

  useEffect(() => {
    const frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={`block ${className}`}
      style={{ width, height }}
      data-testid="pacing-curve-chart"
    />
  );
});

export default PacingCurveChart;
