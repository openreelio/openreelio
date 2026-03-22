/**
 * PlaybackSettings Component
 *
 * Playback-related settings including audio scrubbing and loop behavior.
 */

import type { PlaybackSettings as PlaybackSettingsType } from '@/stores/settingsStore';

interface PlaybackSettingsProps {
  settings: PlaybackSettingsType;
  onUpdate: (values: Partial<PlaybackSettingsType>) => void;
  disabled?: boolean;
}

export function PlaybackSettings({
  settings,
  onUpdate,
  disabled = false,
}: PlaybackSettingsProps) {
  return (
    <div className="space-y-6">
      {/* Audio Scrubbing */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.audioScrubbing}
            onChange={(e) => onUpdate({ audioScrubbing: e.target.checked })}
            disabled={disabled}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-editor-text">Audio scrubbing</span>
            <p className="text-xs text-editor-text-muted">
              Play short audio snippets while dragging the playhead
            </p>
          </div>
        </label>
      </div>

      {/* Loop Playback */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.loopPlayback}
            onChange={(e) => onUpdate({ loopPlayback: e.target.checked })}
            disabled={disabled}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-editor-text">Loop playback</span>
            <p className="text-xs text-editor-text-muted">
              Automatically restart from the beginning when playback reaches the end
            </p>
          </div>
        </label>
      </div>

      {/* Preview Quality */}
      <div>
        <label
          htmlFor="previewQuality"
          className="block text-sm font-medium text-editor-text mb-2"
        >
          Preview Quality
        </label>
        <select
          id="previewQuality"
          value={settings.previewQuality}
          onChange={(e) =>
            onUpdate({
              previewQuality: e.target.value as PlaybackSettingsType['previewQuality'],
            })
          }
          disabled={disabled}
          className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
        >
          <option value="auto">Auto</option>
          <option value="full">Full (1:1)</option>
          <option value="half">Half (1:2)</option>
          <option value="quarter">Quarter (1:4)</option>
        </select>
        <p className="mt-1 text-xs text-editor-text-muted">
          Lower quality improves playback performance on slower hardware
        </p>
      </div>
    </div>
  );
}
