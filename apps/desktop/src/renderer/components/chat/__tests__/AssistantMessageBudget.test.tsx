// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/bots/BotLearningFooter', () => ({ BotLearningFooter: () => null }));
vi.mock('@/features/bots/BotSessionTaskResultCard', () => ({
  BotSessionTaskResultCard: () => null,
}));
vi.mock('@/cindy-brain/ghostCardStore', () => ({
  getGhostCardEntry: () => undefined,
  subscribeGhostCards: () => () => {},
}));
vi.mock('../GhostToolCard', () => ({ GhostToolCard: () => null }));
vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({ capabilities: {} }),
}));
vi.mock('../ChatSessionFileContext', () => ({ useSessionFileOrigin: () => undefined }));
vi.mock('@/lib/sessionFileOrigin', () => ({ originDeviceId: () => undefined }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));
vi.mock('@/lib/composerActionsBus', () => ({ insertSessionLinkIntoComposer: vi.fn() }));
vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock('../shareSelectionStore', () => ({ shareSelectionStore: { enter: vi.fn() } }));
vi.mock('../useForkAtMessage', () => ({ useForkAtMessage: () => vi.fn() }));
vi.mock('../useDeleteMessage', () => ({ useDeleteMessage: () => vi.fn() }));
vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({
  isInteractiveSessionNavigationMode: () => false,
  useSessionNavigationMode: () => 'embedded',
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
  },
}));
vi.mock('../MessageActionBar', async () => {
  const { RequestBudgetBadge } = await import('../RequestBudgetBadge');
  return {
    MessageActionBar: ({ sub2apiBudget }: any) => (
      <div data-testid="actions">
        <RequestBudgetBadge budget={sub2apiBudget} />
      </div>
    ),
  };
});
import { AssistantMessage } from '../AssistantMessage';
afterEach(cleanup);
it('shows one request budget on its nonfinal block without adding an action bar', () => {
  const { container } = render(
    <>
      <AssistantMessage
        workingDir="/test"
        content="first block"
        isStreaming={false}
        showActionBar={false}
        sub2apiBudget={{ state: 'complete', amount: '0.98506000' }}
      />
      <AssistantMessage
        workingDir="/test"
        content="final block"
        isStreaming={false}
        showActionBar
      />
    </>,
  );
  expect(screen.getByText('first block')).toBeTruthy();
  expect(screen.getByText('final block')).toBeTruthy();
  expect(container.querySelectorAll('[data-request-budget]')).toHaveLength(1);
  expect(
    container.querySelector('[data-request-budget]')?.closest('[data-share-exclude]'),
  ).toBeTruthy();
  expect(screen.getAllByTestId('actions')).toHaveLength(1);
});
it('does not duplicate the budget when the same block becomes final', () => {
  const { container, rerender } = render(
    <AssistantMessage
      workingDir="/test"
      content="reply"
      isStreaming={false}
      sub2apiBudget={{ state: 'pending' }}
    />,
  );
  rerender(
    <AssistantMessage
      workingDir="/test"
      content="reply"
      isStreaming={false}
      showActionBar
      sub2apiBudget={{ state: 'pending' }}
    />,
  );
  expect(container.querySelectorAll('[data-request-budget]')).toHaveLength(1);
});
it('does not show partial budget metadata while streaming', () => {
  const { container } = render(
    <AssistantMessage
      workingDir="/test"
      content="stream"
      isStreaming
      sub2apiBudget={{ state: 'pending' }}
    />,
  );
  expect(container.querySelector('[data-request-budget]')).toBeNull();
});
