// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  lookup: vi.fn(),
  create: vi.fn(),
  lastDir: null as string | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/hooks/useMemorySettings', () => ({
  useMemorySettings: () => ({ makerEnabled: true, setMakerEnabled: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/state/lastWorkingDir', () => ({
  getLastWorkingDir: () => mocks.lastDir,
  subscribeToLastWorkingDir: () => () => {},
}));

vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: () => null,
}));

import { MemorySection } from '../MemorySection';

describe('MemorySection workspace identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lastDir = '/tmp/cindy-xdt-project';
    mocks.confirm.mockResolvedValue(true);
    mocks.lookup.mockResolvedValue({ status: 'missing' });
    mocks.create.mockResolvedValue({
      status: 'bound',
      canonicalWorkspaceId: '11111111-1111-4111-8111-111111111111',
      locatorDigest: 'a'.repeat(64),
      created: true,
    });
    window.electronAPI = {
      maker: {
        memoryGet: vi.fn().mockResolvedValue({ enabled: false, source: 'host-runtime' }),
        memoryGetSettingsState: vi.fn().mockResolvedValue({ isCustomized: false }),
        workspaceIdentityLookup: mocks.lookup,
        workspaceIdentityCreate: mocks.create,
      },
    } as never;
  });

  it('does not send create when the confirm dialog is cancelled', async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<MemorySection />);
    await waitFor(() => expect(mocks.lookup).toHaveBeenCalled());
    fireEvent.click(screen.getByText('settings.memory.workspaceIdentity.register'));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('disables register when there is no lastWorkingDir', async () => {
    mocks.lastDir = null;
    render(<MemorySection />);
    const button = await screen.findByText('settings.memory.workspaceIdentity.register');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it('sends confirmed:true only after dialog confirmation', async () => {
    render(<MemorySection />);
    await waitFor(() => expect(mocks.lookup).toHaveBeenCalledWith({ absDir: '/tmp/cindy-xdt-project' }));
    fireEvent.click(screen.getByText('settings.memory.workspaceIdentity.register'));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      absDir: '/tmp/cindy-xdt-project',
      confirmed: true,
    }));
  });
});
