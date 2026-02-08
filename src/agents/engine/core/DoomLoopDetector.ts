/**
 * Doom Loop Detector
 *
 * Detects when the agent is stuck in a repetitive loop,
 * calling the same tool with the same arguments repeatedly.
 * This prevents wasted API calls and runaway behavior.
 */

// =============================================================================
// Types
// =============================================================================

interface ToolCallRecord {
  tool: string;
  argsHash: string;
  timestamp: number;
}

// =============================================================================
// DoomLoopDetector
// =============================================================================

export class DoomLoopDetector {
  private readonly threshold: number;
  private readonly recentCalls: ToolCallRecord[] = [];

  /**
   * @param threshold - Number of consecutive identical calls to trigger detection (default: 3)
   */
  constructor(threshold = 3) {
    if (threshold < 2) {
      throw new Error('Doom loop threshold must be at least 2');
    }
    this.threshold = threshold;
  }

  /**
   * Record a tool call and check if a doom loop is detected.
   *
   * @param tool - Tool name
   * @param args - Tool arguments
   * @returns true if a doom loop is detected
   */
  check(tool: string, args: Record<string, unknown>): boolean {
    const argsHash = this.hashArgs(args);
    this.recentCalls.push({ tool, argsHash, timestamp: Date.now() });

    // Only check the last N calls
    if (this.recentCalls.length < this.threshold) {
      return false;
    }

    const lastN = this.recentCalls.slice(-this.threshold);
    const firstCall = lastN[0];

    return lastN.every(
      (call) => call.tool === firstCall.tool && call.argsHash === firstCall.argsHash
    );
  }

  /**
   * Reset the detector state.
   */
  reset(): void {
    this.recentCalls.length = 0;
  }

  /**
   * Get the number of recorded calls.
   */
  get callCount(): number {
    return this.recentCalls.length;
  }

  /**
   * Create a stable hash of tool arguments for comparison.
   * Sorts keys at all levels for consistent hashing regardless of key order.
   */
  private hashArgs(args: Record<string, unknown>): string {
    try {
      return JSON.stringify(this.deepSortKeys(args));
    } catch {
      return String(args);
    }
  }

  /**
   * Recursively sort object keys to produce a stable structure for hashing.
   */
  private deepSortKeys(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.deepSortKeys(item));
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = this.deepSortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
}
