/**
 * MediaLibrary Component
 *
 * Browser panel for stock media and external media libraries.
 * Currently a placeholder for future implementation.
 */

import { memo } from 'react';
import { Library, Image, Film, Music, FileText, Search, ExternalLink } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface MediaLibraryProps {
  /** Additional CSS classes */
  className?: string;
  /** Callback when a media item is selected */
  onMediaSelect?: (mediaId: string) => void;
}

// =============================================================================
// Placeholder Media Sources
// =============================================================================

const MEDIA_SOURCES = [
  {
    id: 'stock-video',
    name: 'Stock Video',
    icon: <Film className="w-4 h-4" />,
    description: 'Free stock footage',
    status: 'coming-soon',
  },
  {
    id: 'stock-images',
    name: 'Stock Images',
    icon: <Image className="w-4 h-4" />,
    description: 'High-quality photos',
    status: 'coming-soon',
  },
  {
    id: 'stock-music',
    name: 'Music Library',
    icon: <Music className="w-4 h-4" />,
    description: 'Royalty-free music',
    status: 'coming-soon',
  },
  {
    id: 'sound-effects',
    name: 'Sound Effects',
    icon: <FileText className="w-4 h-4" />,
    description: 'SFX library',
    status: 'coming-soon',
  },
];

// =============================================================================
// Component
// =============================================================================

export const MediaLibrary = memo(function MediaLibrary({
  className = '',
  onMediaSelect: _onMediaSelect,
}: MediaLibraryProps) {
  // Placeholder: onMediaSelect will be used when media items are clickable
  void _onMediaSelect;
  return (
    <div className={`h-full overflow-auto ${className}`} data-testid="media-library">
      {/* Header */}
      <div className="p-3 border-b border-editor-border">
        <div className="flex items-center gap-2 text-editor-text">
          <Library className="w-4 h-4 text-primary-500" />
          <span className="text-sm font-medium">Media Library</span>
        </div>
        <p className="text-xs text-editor-text-muted mt-1">Browse and import stock media</p>
      </div>

      {/* Search (placeholder) */}
      <div className="p-2 border-b border-editor-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-editor-text-muted" />
          <input
            type="text"
            placeholder="Search media..."
            className="w-full bg-editor-input border border-editor-border rounded pl-8 pr-2 py-1.5 text-sm text-editor-text placeholder:text-editor-text-muted focus:border-primary-500 focus:outline-none"
            disabled
          />
        </div>
      </div>

      {/* Media Sources */}
      <div className="p-3 space-y-2">
        <p className="text-xs text-editor-text-muted uppercase tracking-wider mb-3">Sources</p>
        {MEDIA_SOURCES.map((source) => (
          <div
            key={source.id}
            className="flex items-start gap-3 p-3 rounded border border-editor-border bg-editor-input bg-opacity-30 opacity-60"
          >
            <div className="p-2 rounded bg-editor-hover text-editor-text-muted">{source.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-editor-text">{source.name}</span>
                <span className="text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">
                  Coming Soon
                </span>
              </div>
              <p className="text-xs text-editor-text-muted mt-0.5">{source.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Links */}
      <div className="p-3 border-t border-editor-border mt-4">
        <p className="text-xs text-editor-text-muted uppercase tracking-wider mb-2">Quick Links</p>
        <div className="space-y-1">
          <a
            href="https://www.pexels.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-primary-400 hover:text-primary-300 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Pexels (Free Stock)
          </a>
          <a
            href="https://pixabay.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-primary-400 hover:text-primary-300 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Pixabay (Free Media)
          </a>
          <a
            href="https://www.pond5.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-primary-400 hover:text-primary-300 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Pond5 (Stock Footage)
          </a>
        </div>
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-editor-border">
        <p className="text-xs text-editor-text-muted text-center italic">
          Integration with Meilisearch coming in v0.2.0
        </p>
      </div>
    </div>
  );
});
