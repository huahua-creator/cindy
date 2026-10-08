import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/tooltip';
import {
  formatBudgetAmount,
  normalizeSub2apiBudget,
  type Sub2apiBudget,
} from '../../../shared/sub2apiBudget';

export function RequestBudgetBadge({
  budget: value,
  className,
  details,
}: {
  budget?: Sub2apiBudget;
  className?: string;
  details?: ReactNode;
}) {
  const { t } = useTranslation();
  const budget = normalizeSub2apiBudget(value);
  if (!budget) return null;
  return (
    <span data-share-exclude="true" data-request-budget className={className}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span>
            {budget.state === 'complete'
              ? t('chat.messageActionBar.requestBudgetValue', {
                  amount: formatBudgetAmount(budget.amount!),
                })
              : t(
                  budget.state === 'pending'
                    ? 'chat.messageActionBar.requestBudgetPending'
                    : 'chat.messageActionBar.requestBudgetUnavailable',
                )}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content>
          <span className="whitespace-pre-line">
            {t('chat.messageActionBar.requestBudgetMeaning')}
            {details && (
              <>
                {'\n'}
                {details}
              </>
            )}
          </span>
        </Tooltip.Content>
      </Tooltip.Root>
    </span>
  );
}
