import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { claudeSdkCostMoney } from '../turnCostCalculator';

// Execute the production fallback dispatch without initializing Electron or SQLite.
const source = readFileSync(resolve(__dirname, '../../maker-ipc/sessionClaudeTurnUsage.ts'), 'utf8');
const start = source.indexOf('const ledgerCurrency = (await getGatewayAccountCurrency())');
const end = source.indexOf('if (changedScheduleId)', start);
if (start < 0 || end < 0) throw new Error('Cumulative SDK fallback dispatch not found');
const body = transpileModule(source.slice(start, end), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

async function run(model: string, amount: number) {
  const deps = {
    getGatewayAccountCurrency: async () => 'USD',
    currentLedgerCurrency: () => 'USD',
    claudeSdkCostMoney,
    resolvedModel: model,
    rawDelta: amount,
    recordUsageOnly: vi.fn(),
    recordTurnSpend: vi.fn(),
    recordSessionTurnSpend: vi.fn(),
    recordSchedulerTurnCost: vi.fn(async () => null),
    session: { id: 'test-session' },
    turnAssistantPersistId: 'test-message',
    turnUsageDetails: { model },
    event: { turnOrigin: undefined },
  };
  await new Function(...Object.keys(deps), `return (async () => { ${body} })();`)(...Object.values(deps));
  return deps;
}

describe('Claude cumulative SDK fallback money dispatch', () => {
  it('retains third-party message estimates without writing actual session or daily spend', async () => {
    const d = await run('gpt-6-astra', 0.49253);
    expect(d.recordTurnSpend).not.toHaveBeenCalled();
    expect(d.recordSessionTurnSpend).not.toHaveBeenCalled();
    expect(d.recordSchedulerTurnCost).toHaveBeenCalledWith(expect.objectContaining({
      money: { amount: 0.49253, currency: 'USD', approximate: true, kind: 'value-estimate' },
    }));
  });

  it('preserves native Claude actual-cost dispatch', async () => {
    const d = await run('claude-opus-4-8', 1);
    expect(d.recordTurnSpend).toHaveBeenCalledWith(expect.objectContaining({ amount: 1, kind: 'actual-cost' }));
    expect(d.recordSessionTurnSpend).toHaveBeenCalledOnce();
  });

  it.each([0, -1, NaN, Infinity])('does not write invalid money %s', async (amount) => {
    const d = await run('gpt-6-astra', amount);
    expect(d.recordUsageOnly).toHaveBeenCalledOnce();
    expect(d.recordTurnSpend).not.toHaveBeenCalled();
    expect(d.recordSessionTurnSpend).not.toHaveBeenCalled();
    expect(d.recordSchedulerTurnCost).not.toHaveBeenCalled();
  });
});
