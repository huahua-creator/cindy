export interface Sub2apiBudget {
  state: 'pending' | 'complete' | 'unavailable';
  amount?: string;
}

export const BUDGET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function budgetUUID(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    BUDGET_UUID.test(value) &&
    value !== '00000000-0000-0000-0000-000000000000'
  );
}
export function budgetDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,11})\.\d{8}$/.test(value);
}
export function normalizeSub2apiBudget(value: unknown): Sub2apiBudget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.state === 'complete' && budgetDecimal(v.amount))
    return { state: 'complete', amount: v.amount };
  if (v.state === 'pending' || v.state === 'unavailable') return { state: v.state };
  return undefined;
}
export function formatBudgetAmount(value: string): string {
  return value.replace(/0+$/, '').replace(/\.$/, '.00');
}

export interface BudgetAttempt {
  id: string;
  owner_id: string;
  session_id: string;
  provider_id: string;
  responses_url: string;
  credential_generation: string;
  client_request_id: string | null;
  response_id: string | null;
  message_client_id: string | null;
  observed_message_rowid?: number;
  state: 'pending' | 'complete' | 'unavailable';
  amount: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export type BudgetMutation =
  | { action: 'observe'; row: BudgetAttempt }
  | { action: 'identify'; ownerId: string; id: string; responseId: string }
  | {
      action: 'link';
      ownerId: string;
      sessionId: string;
      clientId?: string;
      id: string;
      providerId: string;
      responsesUrl: string;
      credentialGeneration: string;
    }
  | { action: 'attempt'; ownerId: string; id: string }
  | { action: 'cleanup'; ownerId: string; now: number }
  | {
      action: 'settle';
      ownerId: string;
      id: string;
      state: 'complete' | 'unavailable';
      amount?: string;
      expected?: {
        sessionId: string;
        providerId: string;
        responsesUrl: string;
        credentialGeneration: string;
        clientRequestId: string;
      };
    };
export interface BudgetMutationResult {
  id?: string;
  messageClientId?: string;
  sessionId?: string;
  allowed?: boolean;
}
