import { fireEvent, render, screen } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LutPanel } from './LutPanel';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

const mockOpen = vi.mocked(open);

describe('LutPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render inactive state and default controls when no LUT file is selected', () => {
    render(<LutPanel params={{}} onChange={vi.fn()} />);

    expect(screen.getByTestId('lut-panel')).toBeInTheDocument();
    expect(screen.getByTestId('lut-status')).toHaveTextContent('Inactive');
    expect(screen.getByPlaceholderText('No file selected')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'LUT interpolation' })).toHaveValue('tetrahedral');
    expect(screen.getByRole('slider', { name: 'LUT intensity' })).toHaveValue('1');
  });

  it('should browse and commit a LUT file', async () => {
    const onChange = vi.fn();
    mockOpen.mockResolvedValueOnce('/looks/film.cube');
    render(<LutPanel params={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse LUT file' }));

    expect(await screen.findByTestId('lut-panel')).toBeInTheDocument();
    expect(mockOpen).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: 'LUT', extensions: ['cube', '3dl', 'lut'] }],
    });
    expect(onChange).toHaveBeenCalledWith('file', '/looks/film.cube');
  });

  it('should clear the active LUT file', () => {
    const onChange = vi.fn();
    render(
      <LutPanel
        params={{ file: '/project/luts/show.cube', interp: 'tetrahedral', intensity: 1 }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear LUT file' }));

    expect(onChange).toHaveBeenCalledWith('file', '');
  });

  it('should change interpolation', () => {
    const onChange = vi.fn();
    render(
      <LutPanel
        params={{ file: '/project/luts/show.cube', interp: 'tetrahedral', intensity: 0.5 }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'LUT interpolation' }), {
      target: { value: 'trilinear' },
    });

    expect(onChange).toHaveBeenCalledWith('interp', 'trilinear');
  });

  it('should change intensity', () => {
    const onChange = vi.fn();
    render(
      <LutPanel
        params={{ file: '/project/luts/show.cube', interp: 'tetrahedral', intensity: 0.5 }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole('slider', { name: 'LUT intensity' }), {
      target: { value: '0.42' },
    });

    expect(onChange).toHaveBeenCalledWith('intensity', 0.42);
  });

  it('should reset LUT parameters', () => {
    const onChange = vi.fn();
    render(
      <LutPanel
        params={{ file: '/project/luts/show.cube', interp: 'nearest', intensity: 0.25 }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset LUT' }));

    expect(onChange).toHaveBeenCalledWith('file', '');
    expect(onChange).toHaveBeenCalledWith('interp', 'tetrahedral');
    expect(onChange).toHaveBeenCalledWith('intensity', 1);
  });

  it('should disable controls in read-only mode', () => {
    render(
      <LutPanel
        params={{ file: '/project/luts/show.cube', interp: 'tetrahedral', intensity: 1 }}
        onChange={vi.fn()}
        readOnly
      />,
    );

    expect(screen.getByRole('button', { name: 'Browse LUT file' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'LUT interpolation' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'LUT intensity' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Clear LUT file' })).not.toBeInTheDocument();
  });
});
