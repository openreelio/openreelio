import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore, _resetCommandQueueForTesting } from '@/stores/projectStore';
import {
  createMockProjectMeta,
  createMockProjectState,
  getMockedInvoke,
  mockTauriCommands,
  resetTauriMocks,
} from '@/test/mocks/tauri';
import { ExternalChangeBanner, ExternalChangeBannerContent } from './ExternalChangeBanner';

describe('ExternalChangeBannerContent', () => {
  it('should render nothing when no external change is pending', () => {
    const { container } = render(
      <ExternalChangeBannerContent
        notice={null}
        isReloading={false}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('should explain that the refused edit was not applied when a command triggered it', () => {
    render(
      <ExternalChangeBannerContent
        notice={{ source: 'command' }}
        isReloading={false}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('That edit was not applied');
    expect(screen.getByRole('alert')).toHaveTextContent('Unsaved changes in this window');
  });

  it('should report the on-disk operation count when the watcher reported one', () => {
    render(
      <ExternalChangeBannerContent
        notice={{ source: 'watcher', opCount: 14 }}
        isReloading={false}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('14 operations');
  });

  it('should disable the actions while a reload is in flight', () => {
    render(
      <ExternalChangeBannerContent
        notice={{ source: 'watcher', opCount: 2 }}
        isReloading
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId('external-change-banner-reload')).toBeDisabled();
    expect(screen.getByTestId('external-change-banner-dismiss')).toBeDisabled();
  });
});

describe('ExternalChangeBanner', () => {
  beforeEach(() => {
    resetTauriMocks();
    _resetCommandQueueForTesting();
    useProjectStore.setState({
      isLoaded: false,
      isLoading: false,
      isDirty: false,
      meta: null,
      assets: new Map(),
      sequences: new Map(),
      effects: new Map(),
      activeSequenceId: null,
      sequenceNavigationStack: [],
      selectedAssetId: null,
      proxyJobIdsByAssetId: {},
      error: null,
      stateVersion: 0,
      externalChange: null,
      isReloadingFromDisk: false,
    });
  });

  it('should stay hidden until the store reports an external change', () => {
    render(<ExternalChangeBanner />);
    expect(screen.queryByTestId('external-change-banner')).not.toBeInTheDocument();

    act(() => {
      useProjectStore.setState({ isLoaded: true });
      useProjectStore.getState().markExternalChange({ source: 'watcher', opCount: 5 });
    });

    expect(screen.getByTestId('external-change-banner')).toBeInTheDocument();
  });

  it('should reload the project from disk when the user chooses to reload', async () => {
    mockTauriCommands({
      reload_project_from_disk: createMockProjectMeta({ name: 'Reloaded Project' }),
      get_project_state: createMockProjectState(),
    });
    useProjectStore.setState({ isLoaded: true });
    useProjectStore.getState().markExternalChange({ source: 'watcher', opCount: 5 });

    render(<ExternalChangeBanner />);
    await userEvent.click(screen.getByTestId('external-change-banner-reload'));

    await waitFor(() => {
      expect(getMockedInvoke()).toHaveBeenCalledWith('reload_project_from_disk');
    });
    await waitFor(() => {
      expect(useProjectStore.getState().externalChange).toBeNull();
    });
    expect(screen.queryByTestId('external-change-banner')).not.toBeInTheDocument();
  });

  it('should clear the notice without reloading when dismissed', async () => {
    useProjectStore.setState({ isLoaded: true });
    useProjectStore.getState().markExternalChange({ source: 'watcher', opCount: 5 });

    render(<ExternalChangeBanner />);
    await userEvent.click(screen.getByTestId('external-change-banner-dismiss'));

    expect(useProjectStore.getState().externalChange).toBeNull();
    expect(getMockedInvoke()).not.toHaveBeenCalled();
  });
});
