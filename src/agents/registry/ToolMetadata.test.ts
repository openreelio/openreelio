/**
 * Tool Metadata Tests
 *
 * Tests for tool metadata utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  createToolMetadata,
  requiresApproval,
  getRiskIndicator,
  canRunInParallel,
  getCombinedRiskLevel,
  filterToolsByMetadata,
  DEFAULT_TOOL_METADATA,
  HIGH_RISK_METADATA,
  TIMELINE_AFFECTING_METADATA,
  type ToolMetadata,
} from './ToolMetadata';

describe('ToolMetadata', () => {
  describe('createToolMetadata', () => {
    it('should return defaults when called with no arguments', () => {
      const metadata = createToolMetadata();
      expect(metadata).toEqual(DEFAULT_TOOL_METADATA);
    });

    it('should merge partial metadata with defaults', () => {
      const metadata = createToolMetadata({
        needsApproval: true,
        riskLevel: 'high',
      });

      expect(metadata.needsApproval).toBe(true);
      expect(metadata.riskLevel).toBe('high');
      expect(metadata.supportsUndo).toBe(false); // default
      expect(metadata.parallelizable).toBe(true); // default
    });

    it('should apply HIGH_RISK_METADATA preset correctly', () => {
      const metadata = createToolMetadata(HIGH_RISK_METADATA);

      expect(metadata.needsApproval).toBe(true);
      expect(metadata.riskLevel).toBe('high');
      expect(metadata.warningMessage).toBeDefined();
    });

    it('should apply TIMELINE_AFFECTING_METADATA preset correctly', () => {
      const metadata = createToolMetadata(TIMELINE_AFFECTING_METADATA);

      expect(metadata.affectsTimeline).toBe(true);
      expect(metadata.supportsUndo).toBe(true);
    });

    it('should allow combining presets', () => {
      const metadata = createToolMetadata({
        ...HIGH_RISK_METADATA,
        ...TIMELINE_AFFECTING_METADATA,
      });

      expect(metadata.needsApproval).toBe(true);
      expect(metadata.riskLevel).toBe('high');
      expect(metadata.affectsTimeline).toBe(true);
      expect(metadata.supportsUndo).toBe(true);
    });
  });

  describe('requiresApproval', () => {
    it('should return true when needsApproval is true', () => {
      const metadata = createToolMetadata({ needsApproval: true });
      expect(requiresApproval(metadata)).toBe(true);
    });

    it('should return true when riskLevel is high', () => {
      const metadata = createToolMetadata({ riskLevel: 'high' });
      expect(requiresApproval(metadata)).toBe(true);
    });

    it('should return false for low risk without approval flag', () => {
      const metadata = createToolMetadata({ riskLevel: 'low' });
      expect(requiresApproval(metadata)).toBe(false);
    });

    it('should return false for medium risk without approval flag', () => {
      const metadata = createToolMetadata({ riskLevel: 'medium' });
      expect(requiresApproval(metadata)).toBe(false);
    });
  });

  describe('getRiskIndicator', () => {
    it('should return correct indicator for low risk', () => {
      expect(getRiskIndicator('low')).toBe('Low Risk');
    });

    it('should return correct indicator for medium risk', () => {
      expect(getRiskIndicator('medium')).toBe('Medium Risk');
    });

    it('should return correct indicator for high risk', () => {
      expect(getRiskIndicator('high')).toContain('High Risk');
      expect(getRiskIndicator('high')).toContain('Approval');
    });
  });

  describe('canRunInParallel', () => {
    it('should return true when all tools are parallelizable', () => {
      const metadataList: ToolMetadata[] = [
        createToolMetadata({ parallelizable: true }),
        createToolMetadata({ parallelizable: true }),
        createToolMetadata({ parallelizable: true }),
      ];

      expect(canRunInParallel(metadataList)).toBe(true);
    });

    it('should return false when any tool is not parallelizable', () => {
      const metadataList: ToolMetadata[] = [
        createToolMetadata({ parallelizable: true }),
        createToolMetadata({ parallelizable: false }),
        createToolMetadata({ parallelizable: true }),
      ];

      expect(canRunInParallel(metadataList)).toBe(false);
    });

    it('should return true for empty list', () => {
      expect(canRunInParallel([])).toBe(true);
    });
  });

  describe('getCombinedRiskLevel', () => {
    it('should return low when all tools are low risk', () => {
      const metadataList: ToolMetadata[] = [
        createToolMetadata({ riskLevel: 'low' }),
        createToolMetadata({ riskLevel: 'low' }),
      ];

      expect(getCombinedRiskLevel(metadataList)).toBe('low');
    });

    it('should return medium when highest is medium', () => {
      const metadataList: ToolMetadata[] = [
        createToolMetadata({ riskLevel: 'low' }),
        createToolMetadata({ riskLevel: 'medium' }),
        createToolMetadata({ riskLevel: 'low' }),
      ];

      expect(getCombinedRiskLevel(metadataList)).toBe('medium');
    });

    it('should return high when any tool is high risk', () => {
      const metadataList: ToolMetadata[] = [
        createToolMetadata({ riskLevel: 'low' }),
        createToolMetadata({ riskLevel: 'high' }),
        createToolMetadata({ riskLevel: 'medium' }),
      ];

      expect(getCombinedRiskLevel(metadataList)).toBe('high');
    });

    it('should return low for empty list', () => {
      expect(getCombinedRiskLevel([])).toBe('low');
    });
  });

  describe('filterToolsByMetadata', () => {
    const toolsMap = new Map<string, ToolMetadata>([
      ['safe_tool', createToolMetadata({ riskLevel: 'low', needsApproval: false })],
      ['risky_tool', createToolMetadata({ riskLevel: 'high', needsApproval: true })],
      ['timeline_tool', createToolMetadata({ affectsTimeline: true, supportsUndo: true })],
      ['slow_tool', createToolMetadata({ parallelizable: false, estimatedDuration: 'slow' })],
    ]);

    it('should filter by needsApproval', () => {
      const result = filterToolsByMetadata(toolsMap, { needsApproval: true });
      expect(result).toContain('risky_tool');
      expect(result).not.toContain('safe_tool');
    });

    it('should filter by riskLevel', () => {
      const result = filterToolsByMetadata(toolsMap, { riskLevel: 'low' });
      expect(result).toContain('safe_tool');
      expect(result).toContain('timeline_tool');
      expect(result).toContain('slow_tool');
      expect(result).not.toContain('risky_tool');
    });

    it('should filter by affectsTimeline', () => {
      const result = filterToolsByMetadata(toolsMap, { affectsTimeline: true });
      expect(result).toContain('timeline_tool');
      expect(result).toHaveLength(1);
    });

    it('should filter by supportsUndo', () => {
      const result = filterToolsByMetadata(toolsMap, { supportsUndo: true });
      expect(result).toContain('timeline_tool');
    });

    it('should filter by parallelizable', () => {
      const result = filterToolsByMetadata(toolsMap, { parallelizable: false });
      expect(result).toContain('slow_tool');
      expect(result).toHaveLength(1);
    });

    it('should return all tools when filter is empty', () => {
      const result = filterToolsByMetadata(toolsMap, {});
      expect(result).toHaveLength(4);
    });
  });
});
