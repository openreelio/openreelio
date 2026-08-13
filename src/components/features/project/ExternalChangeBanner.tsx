/**
 * External Change Banner
 *
 * Shown when another process — `openreelio-cli`, an agent, or a second app
 * window — edited the open project's operation log. The backend refuses further
 * edits until this session reloads, so the banner is the recovery affordance
 * rather than a passive notice.
 */

import { useCallback } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { useToastStore } from '@/hooks/useToast';
import { createLogger } from '@/services/logger';
import { getUserFriendlyError } from '@/utils/errorMessages';
import type { ExternalChangeNotice } from '@/utils/externalChange';

const logger = createLogger('ExternalChangeBanner');

function buildBody(notice: ExternalChangeNotice): string {
  const base =
    notice.source === 'command'
      ? 'That edit was not applied because this project changed on disk outside this window.'
      : 'This project changed on disk outside this window.';

  const detail =
    typeof notice.opCount === 'number' && notice.opCount > 0
      ? ` The operation log now has ${notice.opCount} operations.`
      : '';

  return `${base}${detail} Reload to pick up those edits. Unsaved changes in this window will be discarded.`;
}

export interface ExternalChangeBannerContentProps {
  /** The detected change, or `null` to render nothing. */
  notice: ExternalChangeNotice | null;
  /** Whether a reload is currently in flight. */
  isReloading: boolean;
  /** Invoked when the user chooses to reload the project. */
  onReload: () => void;
  /** Invoked when the user dismisses the banner without reloading. */
  onDismiss: () => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Presentational half of the banner. Kept free of store access so it can be
 * rendered directly in tests and previews.
 */
export function ExternalChangeBannerContent({
  notice,
  isReloading,
  onReload,
  onDismiss,
  className = '',
}: ExternalChangeBannerContentProps): JSX.Element | null {
  if (!notice) {
    return null;
  }

  return (
    <div
      data-testid="external-change-banner"
      role="alert"
      className={`flex flex-wrap items-center gap-3 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 ${className}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-status-warning">
          Project changed outside this window
        </p>
        <p className="mt-1 text-xs text-text-secondary">{buildBody(notice)}</p>
      </div>
      <button
        type="button"
        onClick={onReload}
        disabled={isReloading}
        data-testid="external-change-banner-reload"
        className="rounded bg-primary-600 px-3 py-1 text-sm text-white transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isReloading ? 'Reloading…' : 'Reload project'}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        disabled={isReloading}
        aria-label="Dismiss"
        data-testid="external-change-banner-dismiss"
        className="rounded px-2 py-1 text-sm text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        ✕
      </button>
    </div>
  );
}

export interface ExternalChangeBannerProps {
  /** Additional CSS classes */
  className?: string;
}

/**
 * Container half: reads the external-change flag from the project store and
 * wires the reload action.
 */
export function ExternalChangeBanner({
  className = '',
}: ExternalChangeBannerProps): JSX.Element | null {
  const notice = useProjectStore((state) => state.externalChange);
  const isReloading = useProjectStore((state) => state.isReloadingFromDisk);

  const handleReload = useCallback(() => {
    void useProjectStore
      .getState()
      .reloadProjectFromDisk()
      .catch((error: unknown) => {
        logger.error('Reload after external change failed', { error });
        useToastStore.getState().addToast({
          message: getUserFriendlyError(error, { includeTechnicalDetails: false }),
          variant: 'error',
        });
      });
  }, []);

  const handleDismiss = useCallback(() => {
    useProjectStore.getState().dismissExternalChange();
  }, []);

  return (
    <ExternalChangeBannerContent
      notice={notice}
      isReloading={isReloading}
      onReload={handleReload}
      onDismiss={handleDismiss}
      className={className}
    />
  );
}

export default ExternalChangeBanner;
