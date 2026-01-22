/**
 * UpdateBanner Component
 *
 * Banner displayed when an application update is available.
 * Shows progress during download and prompts for restart when ready.
 */

import { Download, RefreshCw, X, AlertCircle, CheckCircle } from 'lucide-react';
import { useUpdate } from '@/hooks/useUpdate';

export interface UpdateBannerProps {
  /** Additional CSS classes */
  className?: string;
  /** Whether to show on mount (respects settings) */
  checkOnMount?: boolean;
}

export function UpdateBanner({
  className = '',
  checkOnMount = true,
}: UpdateBannerProps) {
  const {
    updateInfo,
    isChecking,
    isInstalling,
    error,
    updateAvailable,
    needsRestart,
    installUpdate,
    relaunch,
    clearError,
    checkForUpdates,
  } = useUpdate({ checkOnMount });

  // Don't render anything if no update info and not checking/error
  if (!isChecking && !error && !updateAvailable && !needsRestart) {
    return null;
  }

  // Checking state
  if (isChecking) {
    return (
      <div className={`bg-editor-sidebar border-b border-editor-border px-4 py-2 ${className}`}>
        <div className="flex items-center gap-3 text-sm text-editor-text-muted">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span>Checking for updates...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={`bg-red-500/10 border-b border-red-500/20 px-4 py-2 ${className}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm text-red-400">
            <AlertCircle className="w-4 h-4" />
            <span>Failed to check for updates: {error}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void checkForUpdates()}
              className="px-2 py-1 text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              Retry
            </button>
            <button
              onClick={clearError}
              className="p-1 text-red-400 hover:text-red-300 transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Needs restart state
  if (needsRestart) {
    return (
      <div className={`bg-green-500/10 border-b border-green-500/20 px-4 py-2 ${className}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm text-green-400">
            <CheckCircle className="w-4 h-4" />
            <span>Update installed successfully. Restart to complete.</span>
          </div>
          <button
            onClick={() => void relaunch()}
            className="px-3 py-1 text-sm bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
          >
            Restart Now
          </button>
        </div>
      </div>
    );
  }

  // Installing state
  if (isInstalling) {
    return (
      <div className={`bg-primary-500/10 border-b border-primary-500/20 px-4 py-2 ${className}`}>
        <div className="flex items-center gap-3 text-sm text-primary-400">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span>Downloading and installing update...</span>
        </div>
      </div>
    );
  }

  // Update available state
  if (updateAvailable && updateInfo) {
    return (
      <div className={`bg-primary-500/10 border-b border-primary-500/20 px-4 py-2 ${className}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm text-primary-400">
            <Download className="w-4 h-4" />
            <span>
              Version {updateInfo.latestVersion} is available
              {updateInfo.currentVersion && ` (current: ${updateInfo.currentVersion})`}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void installUpdate()}
              className="px-3 py-1 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded transition-colors"
            >
              Update Now
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default UpdateBanner;
