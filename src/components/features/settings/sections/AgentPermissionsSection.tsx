/**
 * AgentPermissionsSection
 *
 * Settings section for managing per-tool permission rules.
 * Shows global rules list, add form, preset buttons.
 */

import { useState, useCallback } from 'react';
import { Plus, Trash2, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  usePermissionStore,
  type ToolPermission,
  type PermissionPreset,
} from '@/stores/permissionStore';

// =============================================================================
// Constants
// =============================================================================

const PERMISSION_OPTIONS: { value: ToolPermission; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
];

const PRESET_OPTIONS: { value: PermissionPreset; label: string; description: string }[] = [
  {
    value: 'restrictive',
    label: 'Restrictive',
    description: 'Ask for most tools, only allow read operations',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Allow reads and analysis, ask for modifications',
  },
  {
    value: 'permissive',
    label: 'Permissive',
    description: 'Allow most tools, only ask for destructive operations',
  },
];

const permissionColors: Record<ToolPermission, string> = {
  allow: 'text-green-400',
  ask: 'text-yellow-400',
  deny: 'text-red-400',
};

const permissionIcons: Record<ToolPermission, typeof Shield> = {
  allow: ShieldCheck,
  ask: Shield,
  deny: ShieldAlert,
};

// =============================================================================
// Component
// =============================================================================

export function AgentPermissionsSection() {
  const globalRules = usePermissionStore((s) => s.globalRules);
  const addRule = usePermissionStore((s) => s.addRule);
  const removeRule = usePermissionStore((s) => s.removeRule);
  const setPreset = usePermissionStore((s) => s.setPreset);
  const loadDefaults = usePermissionStore((s) => s.loadDefaults);

  const [newPattern, setNewPattern] = useState('');
  const [newPermission, setNewPermission] = useState<ToolPermission>('ask');

  const handleAddRule = useCallback(() => {
    if (!newPattern.trim()) return;
    addRule(newPattern.trim(), newPermission, 'global');
    setNewPattern('');
    setNewPermission('ask');
  }, [newPattern, newPermission, addRule]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddRule();
      }
    },
    [handleAddRule],
  );

  return (
    <div data-testid="agent-permissions-section">
      <h3 className="text-base font-medium text-editor-text mb-1">
        Agent Permissions
      </h3>
      <p className="text-xs text-editor-text-muted mb-4">
        Control which tools the AI agent can use without asking.
        Patterns support wildcards (e.g., <code className="bg-surface-elevated px-1 rounded">get_*</code>).
      </p>

      {/* Presets */}
      <div className="mb-4">
        <label className="text-xs font-medium text-editor-text-muted block mb-2">
          Presets
        </label>
        <div className="flex gap-2 flex-wrap">
          {PRESET_OPTIONS.map((preset) => (
            <button
              key={preset.value}
              onClick={() => setPreset(preset.value)}
              className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-active border border-border-subtle rounded-lg transition-colors text-editor-text"
              title={preset.description}
              data-testid={`preset-${preset.value}`}
            >
              {preset.label}
            </button>
          ))}
          <button
            onClick={loadDefaults}
            className="px-3 py-1.5 text-xs text-editor-text-muted hover:text-editor-text border border-border-subtle rounded-lg transition-colors"
            title="Reset to balanced defaults"
            data-testid="preset-reset"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Rules list */}
      <div className="mb-4">
        <label className="text-xs font-medium text-editor-text-muted block mb-2">
          Rules (last match wins)
        </label>
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {globalRules.map((rule) => {
            const PermIcon = permissionIcons[rule.permission];
            return (
              <div
                key={rule.id}
                className="flex items-center gap-2 px-3 py-1.5 bg-surface-elevated rounded-lg group"
                data-testid="permission-rule"
              >
                <PermIcon
                  className={`w-3.5 h-3.5 ${permissionColors[rule.permission]}`}
                />
                <span className="flex-1 font-mono text-xs text-editor-text">
                  {rule.pattern}
                </span>
                <span
                  className={`text-xs font-medium ${permissionColors[rule.permission]}`}
                >
                  {rule.permission}
                </span>
                <button
                  onClick={() => removeRule(rule.id)}
                  className="p-0.5 opacity-0 group-hover:opacity-100 text-editor-text-muted hover:text-red-400 transition-all"
                  aria-label={`Delete rule ${rule.pattern}`}
                  data-testid="delete-rule-btn"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
          {globalRules.length === 0 && (
            <p className="text-xs text-editor-text-muted px-3 py-2">
              No rules configured. All tools will require approval.
            </p>
          )}
        </div>
      </div>

      {/* Add rule form */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Pattern (e.g., split_*)"
          className="flex-1 px-3 py-1.5 text-xs bg-surface-elevated border border-border-subtle rounded-lg text-editor-text placeholder-editor-text-muted focus:outline-none focus:ring-1 focus:ring-primary-500/50"
          data-testid="new-rule-pattern"
        />
        <select
          value={newPermission}
          onChange={(e) =>
            setNewPermission(e.target.value as ToolPermission)
          }
          className="px-2 py-1.5 text-xs bg-surface-elevated border border-border-subtle rounded-lg text-editor-text focus:outline-none focus:ring-1 focus:ring-primary-500/50"
          data-testid="new-rule-permission"
        >
          {PERMISSION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          onClick={handleAddRule}
          disabled={!newPattern.trim()}
          className="p-1.5 bg-primary-600 hover:bg-primary-500 disabled:bg-surface-active disabled:text-text-tertiary text-white rounded-lg transition-colors"
          aria-label="Add rule"
          data-testid="add-rule-btn"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
