import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.HMAC_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.MCP_UPSTREAM_URL = 'http://localhost:1';
process.env.JWKS_URI = 'http://localhost:1/jwks';
process.env.ID_JAG_ISSUER = 'test-issuer';
process.env.ID_JAG_AUDIENCE = 'test-audience';
process.env.ID_JAG_RESOURCE = 'test-resource';
// Deliberately set here rather than relying on the shipped defaults, so
// this test suite's expected numbers stay correct even if the defaults in
// env.ts are ever tuned differently later.
process.env.DEFAULT_TEAM_TOKEN_BUDGET_7D = '2000000';
process.env.BUDGET_SPIKE_THRESHOLD_MULTIPLIER = '5';
process.env.OUTPUT_TOKEN_COST_WEIGHT = '3';

const { checkBudget, recordActualUsage, estimateRequestCost } = await import('../../src/services/budgetGuard.ts');
type RequestCostEstimateT = import('../../src/services/budgetGuard.ts').RequestCostEstimate;
type JsonRpcRequestT = import('../../src/core/jsonRpc/types.ts').JsonRpcRequest;

const HOUR_MS = 60 * 60 * 1000;
let fakeNowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const clock = () => fakeNowMs;
const advanceHours = (h: number) => {
  fakeNowMs += h * HOUR_MS;
};

const dummyBody: JsonRpcRequestT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'get_weather', arguments: { city: 'a city name of modest length' } },
};

/** A fixed-cost synthetic request so ledger math across many simulated hours stays exactly predictable. weightedTotal = 100 + 100*3 = 400, matching the OUTPUT_TOKEN_COST_WEIGHT set above. */
function fixedCost(): RequestCostEstimateT {
  return { inputTokens: 100, projectedOutputTokens: 100, weightedTotal: 400 };
}
const fixedResponse = { content: [{ type: 'text', text: 'x'.repeat(40) }] };

describe('checkBudget: basic gating', () => {
  test('a fresh team is allowed and has close to the full default budget remaining', async () => {
    const cost = estimateRequestCost(dummyBody, 'get_weather');
    const result = await checkBudget('team-fresh-basic', cost, clock);
    assert.equal(result.allowed, true);
    assert.ok(result.allowed);
    assert.ok(result.remainingBudget > 1_900_000);
  });

  test('a single request exceeding the whole 7-day limit is denied on HARD_CAP with exact overage math', async () => {
    const hugeCost: RequestCostEstimateT = { inputTokens: 100, projectedOutputTokens: 1_000_000, weightedTotal: 3_000_100 };
    const result = await checkBudget('team-hard-cap', hugeCost, clock);
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed);
    assert.equal(result.projection.triggeredBy, 'HARD_CAP');
    assert.equal(result.projection.overageTokens, 3_000_100 - 2_000_000);
  });

  test('a denied request is NOT recorded into the ledger (no ratchet effect for a team already over budget)', async () => {
    const teamId = 'team-no-ratchet';
    const modest = fixedCost();
    await checkBudget(teamId, modest, clock); // allowed, records 400
    const huge: RequestCostEstimateT = { inputTokens: 100, projectedOutputTokens: 1_000_000, weightedTotal: 5_000_000 };
    const denied = await checkBudget(teamId, huge, clock); // denied, must NOT record 5,000,000
    const after = await checkBudget(teamId, modest, clock); // a second modest request right after
    assert.equal(denied.allowed, false);
    assert.equal(after.allowed, true);
    assert.ok(after.allowed);
    // Exactly one prior 400-token request should be reflected -- the huge
    // denied request contributed nothing.
    assert.equal(after.remainingBudget, 2_000_000 - 400);
  });
});

describe('checkBudget: sliding window and spike detection (simulated time)', () => {
  test('144 simulated hours (6 days) of steady 400/hr traffic are all allowed', async () => {
    const teamId = 'team-steady';
    for (let h = 0; h < 144; h++) {
      const result = await checkBudget(teamId, fixedCost(), clock);
      assert.equal(result.allowed, true, `hour ${h} was unexpectedly denied`);
      advanceHours(1);
    }
  });

  test('a sudden burst well within the hard cap is still caught by ANOMALOUS_GROWTH_RATE, independent of cumulative total', async () => {
    const teamId = 'team-spike';
    // Build the same 144h steady baseline as the previous test, using a
    // team-local clock so this test is independent of test execution order.
    let localNow = Date.UTC(2026, 0, 1, 0, 0, 0);
    const localClock = () => localNow;
    for (let h = 0; h < 144; h++) {
      await checkBudget(teamId, fixedCost(), localClock);
      localNow += HOUR_MS;
    }

    // 50 requests at 400 weighted each = 20,000 in a single hour, against a
    // steady baseline of 400/hour. Cumulative total so far: 144*400 +
    // 20,000 = 77,600 -- nowhere near the 2,000,000 hard cap, isolating the
    // spike detector from the hard-cap check entirely.
    let deniedAt = -1;
    let lastResult;
    for (let i = 0; i < 50; i++) {
      lastResult = await checkBudget(teamId, fixedCost(), localClock);
      if (!lastResult.allowed) {
        deniedAt = i;
        break;
      }
    }

    assert.ok(deniedAt >= 0, 'the burst was never denied');
    assert.ok(lastResult && !lastResult.allowed);
    if (lastResult && !lastResult.allowed) {
      assert.equal(lastResult.projection.triggeredBy, 'ANOMALOUS_GROWTH_RATE');
      assert.equal(lastResult.projection.overageTokens, 0, 'this is a rate trigger, not a cumulative cap breach');
      assert.ok(lastResult.projection.windowUsageTokens < 200_000);
      assert.ok((lastResult.projection.spikeFactor ?? 0) > 5);
      // Regression coverage for a real bug caught and fixed during Phase 4:
      // the baseline rate must reflect the true pre-burst steady rate
      // (~400/hr), not be diluted toward a much lower number by phantom
      // zero-hours predating the team's actual history.
      assert.ok(
        Math.abs((lastResult.projection.baselineRunRatePerHour ?? 0) - 400) < 50,
        `baselineRunRatePerHour was ${lastResult.projection.baselineRunRatePerHour}, expected ~400`,
      );
    }
  });

  test('a brand-new team is never spike-flagged on its first burst (cold-start guard against a near-zero baseline)', async () => {
    const teamId = 'team-cold-start';
    let localNow = Date.UTC(2026, 0, 1, 0, 0, 0);
    const localClock = () => localNow;
    let deniedEarly = false;
    for (let i = 0; i < 10; i++) {
      const result = await checkBudget(teamId, fixedCost(), localClock);
      if (!result.allowed) {
        deniedEarly = true;
        break;
      }
    }
    assert.equal(deniedEarly, false, 'a new team was denied before it had enough history for the spike check to be meaningful');
  });
});

describe('recordActualUsage: post-hoc true-up', () => {
  test('trues up the ledger with the ACTUAL response size, and updates the per-tool projection accordingly', async () => {
    const teamId = 'team-trueup';
    const toolName = 'trueup_only_tool';
    const localClock = () => Date.UTC(2026, 0, 1, 0, 0, 0);

    // Deliberately overestimate the projected output (100) versus what
    // fixedResponse will actually measure at.
    const cost1: RequestCostEstimateT = { inputTokens: 50, projectedOutputTokens: 100, weightedTotal: 50 + 100 * 3 }; // 350
    const gate = await checkBudget(teamId, cost1, localClock);
    assert.equal(gate.allowed, true);

    await recordActualUsage(teamId, toolName, cost1, fixedResponse, localClock);

    // fixedResponse's real estimated size under the default calibration
    // profile is small (a short text string) -- independently confirmed at
    // 24 tokens during Phase 4's development. The true-up delta should be
    // exactly (24 - 100) * 3 = -228, landing the ledger at 350 - 228 = 122.
    const expectedDelta = (24 - 100) * 3;
    const peek: RequestCostEstimateT = { inputTokens: 0, projectedOutputTokens: 0, weightedTotal: 0 };
    const afterTrueUp = await checkBudget(teamId, peek, localClock);
    assert.equal(afterTrueUp.remainingBudget, 2_000_000 - (350 + expectedDelta));

    // The per-tool EMA should now reflect the real observed size for
    // FUTURE projections, not the cold-start default (256).
    const nextEstimate = estimateRequestCost(dummyBody, toolName);
    assert.equal(nextEstimate.projectedOutputTokens, 24);
  });
});
