import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceSettings } from './PerformanceSettings';
import type { PerformanceSettings as PerformanceSettingsType } from '@/stores/settingsStore';
import { DESKTOP_RUNTIME_TEST_FLAG } from '@/services/runtimeEnvironment';

vi.mock('@/bindings', () => ({
  commands: {
    detectGpuDevices: vi.fn(),
  },
}));

import { commands } from '@/bindings';

const baseSettings: PerformanceSettingsType = {
  hardwareAcceleration: true,
  gpuDeviceId: 'gpu-nvidia',
  proxyGeneration: true,
  proxyResolution: '720p',
  maxConcurrentJobs: 4,
  memoryLimitMb: 0,
  cacheSizeMb: 1024,
};

describe('PerformanceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = true;
    vi.mocked(commands.detectGpuDevices).mockResolvedValue({
      status: 'ok',
      data: {
        enabled: true,
        activeDeviceId: 'gpu-nvidia',
        devices: [
          {
            id: 'gpu-nvidia',
            name: 'NVIDIA GPU',
            vendor: 'NVIDIA',
            hasEncode: true,
            hasDecode: true,
            isPrimary: true,
          },
        ],
        availableEncoders: { hardware: [], hasHardware: false },
        availableDecoders: { hardware: [], hasHardware: false },
      },
    } as never);
  });

  it('should toggle hardware acceleration off', async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    render(<PerformanceSettings settings={baseSettings} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText('Hardware acceleration')).toBeTruthy();
    });

    await user.click(screen.getByRole('checkbox', { name: /hardware acceleration/i }));

    expect(onUpdate).toHaveBeenCalledWith({ hardwareAcceleration: false });
  });

  it('should toggle proxy generation off', async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    render(<PerformanceSettings settings={baseSettings} onUpdate={onUpdate} />);

    await user.click(screen.getByRole('checkbox', { name: /proxy generation/i }));

    expect(onUpdate).toHaveBeenCalledWith({ proxyGeneration: false });
  });

  it('should change proxy resolution', async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    render(<PerformanceSettings settings={baseSettings} onUpdate={onUpdate} />);

    await user.selectOptions(screen.getByLabelText(/proxy resolution/i), '480p');

    expect(onUpdate).toHaveBeenCalledWith({ proxyResolution: '480p' });
  });

  it('should update max concurrent jobs', async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    render(<PerformanceSettings settings={baseSettings} onUpdate={onUpdate} />);

    const input = screen.getByLabelText(/max concurrent jobs/i);
    await user.clear(input);
    await user.type(input, '8');

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrentJobs: expect.any(Number) }),
    );
  });

  it('should enforce minimum cache size of 128 MB', async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    render(<PerformanceSettings settings={baseSettings} onUpdate={onUpdate} />);

    const input = screen.getByLabelText(/cache size/i);
    await user.clear(input);
    await user.type(input, '50');

    // All calls should clamp to at least 128
    const cacheCalls = onUpdate.mock.calls.filter(
      (call: unknown[]) => 'cacheSizeMb' in (call[0] as Record<string, unknown>),
    );
    for (const call of cacheCalls) {
      expect(call[0].cacheSizeMb).toBeGreaterThanOrEqual(128);
    }
  });

  it('should disable all controls when disabled prop is true', () => {
    render(
      <PerformanceSettings settings={baseSettings} onUpdate={vi.fn()} disabled />,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    for (const checkbox of checkboxes) {
      expect(checkbox).toBeDisabled();
    }

    const inputs = screen.getAllByRole('spinbutton');
    for (const input of inputs) {
      expect(input).toBeDisabled();
    }
  });
});
