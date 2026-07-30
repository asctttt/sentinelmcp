import { env } from '../config/env.js';
import type { JsonRpcRequest } from '../core/jsonRpc/types.js';
import type { BudgetProjection } from '../core/mcp/types.js';

/**
 * Real token-cost estimation and sliding-window budget enforcement,
 * replacing the Phase 1 mock (which always allowed, and estimated tokens as
 * a flat `JSON.stringify(payload).length / 4`).
 *
 * STATEFULNESS WARNING — read this before deploying more than one replica.
 * Everything in this module lives in process memory. That puts it in the
 * same category as `services/sessionManager.ts`'s SSE session map: the rest
 * of this gateway (Phase 1's Streamable HTTP path, policy checks, identity
 * checks) is genuinely stateless and safe behind a plain round-robin load
 * balancer, because any replica can correctly answer any request. This
 * module is NOT. Two concrete failure modes if you run N replicas without
 * addressing this:
 *   1. Each replica has its OWN independent ledger, so a team's real
 *      effective budget becomes N times the configured limit (traffic
 *      splits across replicas; none of them sees the whole picture).
 *   2. Every process restart / redeploy silently resets the entire 7-day
 *      trailing window to zero — exactly the history a rolling-average
 *      spike detector depends on to tell "normal" from "anomalous."
 * The public interface below (`checkBudget` / `recordActualUsage`, both
 * already `async`) is deliberately shaped so a real distributed store —
 * Redis with a sliding-window sorted-set, or similar — can replace the
 * in-memory `Map` in this file as a drop-in, without changing any call site
 * in proxyInterceptor.ts. That swap is the real fix for multi-replica
 * deployment; this module is the MVP "simulate the algorithm in-memory"
 * version asked for in Phase 4, not a production-scale substitute for it.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A pre-call cost estimate: what THIS request is projected to cost, before it's sent upstream. */
export interface RequestCostEstimate {
  /** Tokens to serialize the request itself (method, params, tool arguments) — measured exactly; we have the real body. */
  inputTokens: number;
  /** Tokens the eventual tool result is projected to cost — NOT measured yet (the call hasn't happened). See projectOutputTokens(). */
  projectedOutputTokens: number;
  /** inputTokens + projectedOutputTokens, with output weighted per OUTPUT_TOKEN_COST_WEIGHT. This is what the budget ledger actually compares against the limit. */
  weightedTotal: number;
}

/**
 * Outcome of a budget gate check. A discriminated union on `allowed`
 * rather than an optional `projection?` field: this lets TypeScript prove
 * `projection` is present at every call site that has already checked
 * `!budget.allowed`, with no non-null assertion needed — the type itself
 * states the real invariant (a denial always carries a projection; an
 * allow never needs one) instead of leaving it as a convention to trust.
 *
 * `estimatedTokens` keeps the Phase 1-established field name, now backed by
 * `RequestCostEstimate.weightedTotal` rather than a flat char-count
 * heuristic. `remainingBudget` is weighted-token headroom in the trailing
 * 7-day window BEFORE this request's own cost, floored at 0.
 */
export type BudgetCheck =
  | { allowed: true; estimatedTokens: number; remainingBudget: number }
  | { allowed: false; estimatedTokens: number; remainingBudget: number; projection: BudgetProjection };

/** Injectable clock so the sliding window and spike detector can be tested deterministically without waiting real days. Every exported function defaults to the real clock; proxyInterceptor.ts never needs to pass one. */
export type Clock = () => number;
const realClock: Clock = () => Date.now();

// ---------------------------------------------------------------------------
// Token-shape calibration — an ENGINEERING knob (code constant), not an
// OPS knob (env var). See the block comment on env.ts's Phase 4 additions
// for why business policy (budget limits, spike threshold, output weight)
// lives in env vars while "how many characters approximate a token" lives
// here instead.
// ---------------------------------------------------------------------------

export interface TokenCalibrationProfile {
  /** Approximate characters per token for natural-language string content (tool arguments/descriptions, result text). ~4 is the commonly-cited rule of thumb for English text across most BPE-family tokenizers — an approximation, not an exact figure for any specific model. */
  proseCharsPerToken: number;
  /** Approximate characters per token for JSON structure itself — keys, punctuation, delimiters. Denser than prose (more tokens per character) because short keys and punctuation runs tend to tokenize close to 1:1 in most BPE tokenizers. */
  structuralCharsPerToken: number;
  /** Small fixed allowance per call for the role/function-call wrapper overhead most providers add when a tool call or result is spliced into an LLM's context. A calibration knob, not a verified constant for any named provider — tune it if you have real measurements. */
  perCallOverheadTokens: number;
}

/**
 * One default profile shipped for Phase 4. `estimateRequestCost` accepts an
 * override so this can genuinely be "based on the targeted model" per the
 * brief, without this file asserting specific per-model character ratios
 * that haven't actually been measured against that model's real tokenizer.
 */
export const DEFAULT_CALIBRATION: TokenCalibrationProfile = {
  proseCharsPerToken: 4,
  structuralCharsPerToken: 2.8,
  perCallOverheadTokens: 8,
};

/**
 * Recursively estimates tokens for an arbitrary JSON value by walking its
 * real structure — NOT by `JSON.stringify`-ing the whole thing and dividing
 * by one flat ratio (the Phase 1 mock's approach). String leaf *values* are
 * charged at the prose rate (they're usually natural-language-ish: queries,
 * descriptions, tool result text); everything else — object keys, JSON
 * punctuation, numbers, booleans, null — is charged at the denser
 * structural rate. This is "calibrated" in the sense of being
 * structure-aware, not in the sense of being an exact count measured
 * against a real tokenizer; see the profile's own doc comments for what
 * each ratio represents and its limits.
 */
function estimateJsonTokens(value: unknown, profile: TokenCalibrationProfile): number {
  if (value === null || value === undefined) {
    return 1 / profile.structuralCharsPerToken; // "null" — cheap, but not free
  }
  if (typeof value === 'string') {
    // +2 for the surrounding quote characters, which are structural, not prose.
    return value.length / profile.proseCharsPerToken + 2 / profile.structuralCharsPerToken;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).length / profile.structuralCharsPerToken;
  }
  if (Array.isArray(value)) {
    const commas = Math.max(0, value.length - 1);
    const brackets = 2;
    return (
      value.reduce((sum: number, item) => sum + estimateJsonTokens(item, profile), 0) +
      (commas + brackets) / profile.structuralCharsPerToken
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const commas = Math.max(0, entries.length - 1);
    const braces = 2;
    let total = (commas + braces) / profile.structuralCharsPerToken;
    for (const [key, val] of entries) {
      // Keys are structural (short, punctuation-adjacent, machine-facing),
      // not prose, even though they're technically strings.
      total += (key.length + 3) / profile.structuralCharsPerToken; // +3 for quotes + colon
      total += estimateJsonTokens(val, profile);
    }
    return total;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Output-side projection: per-tool historical rolling average (EMA).
// ---------------------------------------------------------------------------

/** Cold-start assumption for a tool this gateway has never seen a real response from yet. Deliberately conservative-but-modest; tune per deployment if your tools' typical result sizes differ a lot from this. */
const DEFAULT_PROJECTED_OUTPUT_TOKENS = 256;

/** Exponential-moving-average smoothing factor for updating a tool's observed output size. Higher = adapts faster to recent calls; 0.2 is a standard, unremarkable starting point. */
const OUTPUT_EMA_ALPHA = 0.2;

interface ToolOutputProfile {
  emaOutputTokens: number;
  samples: number;
}

const toolOutputProfiles = new Map<string, ToolOutputProfile>();

function projectOutputTokens(toolName: string | undefined): number {
  if (!toolName) return DEFAULT_PROJECTED_OUTPUT_TOKENS;
  const profile = toolOutputProfiles.get(toolName);
  return profile ? profile.emaOutputTokens : DEFAULT_PROJECTED_OUTPUT_TOKENS;
}

function updateToolOutputProfile(toolName: string | undefined, actualOutputTokens: number): void {
  if (!toolName) return;
  const existing = toolOutputProfiles.get(toolName);
  if (!existing) {
    toolOutputProfiles.set(toolName, { emaOutputTokens: actualOutputTokens, samples: 1 });
    return;
  }
  existing.emaOutputTokens += OUTPUT_EMA_ALPHA * (actualOutputTokens - existing.emaOutputTokens);
  existing.samples += 1;
}

// ---------------------------------------------------------------------------
// Pre-call estimation — the public entry point proxyInterceptor.ts calls
// before forwarding, to get the numbers checkBudget needs.
// ---------------------------------------------------------------------------

export function estimateRequestCost(
  body: JsonRpcRequest,
  toolName: string | undefined,
  profile: TokenCalibrationProfile = DEFAULT_CALIBRATION,
): RequestCostEstimate {
  const inputTokens = Math.ceil(estimateJsonTokens(body, profile) + profile.perCallOverheadTokens);
  const projectedOutputTokens = Math.ceil(projectOutputTokens(toolName));
  const weightedTotal = Math.ceil(inputTokens + projectedOutputTokens * env.OUTPUT_TOKEN_COST_WEIGHT);
  return { inputTokens, projectedOutputTokens, weightedTotal };
}

// ---------------------------------------------------------------------------
// The sliding-window ledger: hourly buckets over a 7-day (168-hour)
// circular buffer per team. Standard "sliding window counter" rate-limiter
// design — bounded memory (168 numbers per team, not one entry per
// request), correct trailing-window sums via lazy per-slot staleness
// checks (no background sweep needed).
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_HOURS = 24 * 7; // 168 — the trailing 7-day window itself
const SPIKE_WINDOW_HOURS = 3; // "current rate" = trailing 3h; smooths single-hour noise while still catching a burst early
const MIN_REQUESTS_FOR_SPIKE_CHECK = 20; // don't trust a rate computed from a handful of requests — see the cold-start note on checkBudget

interface HourBucket {
  /** Math.floor(timestampMs / HOUR_MS) — which hour this bucket currently represents. */
  hourEpoch: number;
  weightedTokens: number;
  requestCount: number;
}

interface TeamLedger {
  /** Fixed-length circular buffer, index = hourEpoch % WINDOW_HOURS. */
  buckets: (HourBucket | undefined)[];
}

const ledgers = new Map<string, TeamLedger>();

function getLedger(teamId: string): TeamLedger {
  let ledger = ledgers.get(teamId);
  if (!ledger) {
    ledger = { buckets: new Array(WINDOW_HOURS) };
    ledgers.set(teamId, ledger);
  }
  return ledger;
}

/** For WRITES: returns the bucket for this hour, lazily resetting it if this circular slot currently holds a stale (different) hour. */
function getWritableBucket(ledger: TeamLedger, hourEpoch: number): HourBucket {
  const slot = hourEpoch % WINDOW_HOURS;
  const existing = ledger.buckets[slot];
  if (existing && existing.hourEpoch === hourEpoch) return existing;
  const fresh: HourBucket = { hourEpoch, weightedTokens: 0, requestCount: 0 };
  ledger.buckets[slot] = fresh;
  return fresh;
}

interface WindowSums {
  totalWeightedTokens: number;
  totalRequests: number;
  /** Sum over just the trailing SPIKE_WINDOW_HOURS. */
  recentWeightedTokens: number;
  /** Sum over the OLDER portion of the window (total minus recent) — the pre-spike baseline. Isolated on purpose: see the comment on checkBudget for why a sustained spike must not inflate its own baseline. */
  baselineWeightedTokens: number;
  baselineRequests: number;
  /** Oldest non-stale bucket's hourEpoch, or null if this team has no data at all yet. Used to derive how many hours of REAL history exist, rather than assuming the full window — see checkBudget. */
  oldestBucketHourEpoch: number | null;
}

/** For READS: sums all non-stale buckets in the window. Staleness is checked by age here directly, so this doesn't need (and doesn't trigger) any writes. */
function sumWindow(ledger: TeamLedger, nowHourEpoch: number): WindowSums {
  let totalWeightedTokens = 0;
  let totalRequests = 0;
  let recentWeightedTokens = 0;
  let baselineWeightedTokens = 0;
  let baselineRequests = 0;
  let oldestBucketHourEpoch: number | null = null;

  for (const bucket of ledger.buckets) {
    if (!bucket) continue;
    const ageHours = nowHourEpoch - bucket.hourEpoch;
    if (ageHours < 0 || ageHours >= WINDOW_HOURS) continue; // stale, or (shouldn't happen) clock skew into the future

    totalWeightedTokens += bucket.weightedTokens;
    totalRequests += bucket.requestCount;
    if (oldestBucketHourEpoch === null || bucket.hourEpoch < oldestBucketHourEpoch) {
      oldestBucketHourEpoch = bucket.hourEpoch;
    }

    if (ageHours < SPIKE_WINDOW_HOURS) {
      recentWeightedTokens += bucket.weightedTokens;
    } else {
      baselineWeightedTokens += bucket.weightedTokens;
      baselineRequests += bucket.requestCount;
    }
  }

  return { totalWeightedTokens, totalRequests, recentWeightedTokens, baselineWeightedTokens, baselineRequests, oldestBucketHourEpoch };
}

// ---------------------------------------------------------------------------
// Per-team policy. MOCK — mirrors policyStore.ts's pattern (a real
// deployment backs this with a database/admin panel keyed on the team /
// "virtual API key" identity). Kept inside budgetGuard.ts rather than its
// own file because, unlike the tool-denylist, a team's budget policy is
// intrinsically part of budget logic, not an orthogonal concern.
// ---------------------------------------------------------------------------

interface BudgetPolicy {
  maxWeightedTokens7d: number;
  spikeThresholdMultiplier: number;
}

const POLICY_OVERRIDES: Record<string, Partial<BudgetPolicy>> = {
  // 'team-finance-eu': { maxWeightedTokens7d: 50_000_000 },
};

function getBudgetPolicy(teamId: string): BudgetPolicy {
  const overrides = POLICY_OVERRIDES[teamId];
  return {
    maxWeightedTokens7d: overrides?.maxWeightedTokens7d ?? env.DEFAULT_TEAM_TOKEN_BUDGET_7D,
    spikeThresholdMultiplier: overrides?.spikeThresholdMultiplier ?? env.BUDGET_SPIKE_THRESHOLD_MULTIPLIER,
  };
}

// ---------------------------------------------------------------------------
// The gate itself.
// ---------------------------------------------------------------------------

/**
 * Decides whether a request may proceed, against the team's trailing 7-day
 * weighted-token ledger. Two independent triggers, checked every call:
 *
 *   HARD_CAP — cumulative usage + this request's estimated cost would
 *   exceed the team's configured 7-day limit. The straightforward case.
 *
 *   ANOMALOUS_GROWTH_RATE — even under the hard cap, this team's recent
 *   run-rate (trailing SPIKE_WINDOW_HOURS, smoothed) is accelerating
 *   sharply against its OWN pre-spike baseline (the older portion of the
 *   same 7-day window, deliberately excluding the recent window so a
 *   SUSTAINED spike can't gradually inflate the very baseline it's being
 *   measured against — a spike that dilutes its own comparison point would
 *   stop looking like a spike after a few hours, which defeats "catch it
 *   early"). This trigger is skipped entirely — not defaulted to "not
 *   anomalous," genuinely skipped — for a team with fewer than
 *   MIN_REQUESTS_FOR_SPIKE_CHECK baseline requests, so a brand-new team's
 *   first real burst of traffic isn't compared against a near-zero
 *   baseline and flagged as an "infinite" spike.
 *
 * On allow: usage is recorded into the CURRENT hour's bucket immediately,
 * using the pre-call estimate (input measured exactly, output projected).
 * On deny: nothing is recorded — a blocked call didn't actually happen, so
 * charging its estimated cost would double-penalize a team already at its
 * limit and create a ratchet it could never recover from within the
 * window. See recordActualUsage() for the post-hoc true-up once a real
 * response comes back, which is what keeps the projected side of the
 * ledger honest over time.
 */
export async function checkBudget(
  teamId: string,
  cost: RequestCostEstimate,
  clock: Clock = realClock,
): Promise<BudgetCheck> {
  const policy = getBudgetPolicy(teamId);
  const ledger = getLedger(teamId);
  const nowHourEpoch = Math.floor(clock() / HOUR_MS);
  const sums = sumWindow(ledger, nowHourEpoch);

  const totalAfterThisRequest = sums.totalWeightedTokens + cost.weightedTotal;
  const hardCapBreached = totalAfterThisRequest > policy.maxWeightedTokens7d;

  const hasEnoughHistory = sums.baselineRequests >= MIN_REQUESTS_FOR_SPIKE_CHECK;
  // Real elapsed hours of history for this team, capped at the full
  // window — NOT always WINDOW_HOURS - SPIKE_WINDOW_HOURS. A team that has
  // only existed for, say, 30 hours has at most ~27 real baseline hours of
  // data; dividing its baseline sum by the full 165-hour window width would
  // silently dilute the computed rate with ~138 phantom zero-hours that
  // predate the team entirely, understating its true baseline and — since
  // spikeFactor = current / baseline — inflating spikeFactor for every
  // team younger than a full window, even under perfectly steady behavior.
  const hoursOfHistory =
    sums.oldestBucketHourEpoch === null ? 0 : Math.min(WINDOW_HOURS, nowHourEpoch - sums.oldestBucketHourEpoch + 1);
  const baselineHours = Math.max(1, hoursOfHistory - SPIKE_WINDOW_HOURS);
  const baselineRunRatePerHour = hasEnoughHistory ? sums.baselineWeightedTokens / baselineHours : null;
  // Include this request's own cost in "current rate" — it's the thing
  // asking to be let through, so it should count toward its own rate check.
  const currentRunRatePerHour = (sums.recentWeightedTokens + cost.weightedTotal) / SPIKE_WINDOW_HOURS;
  const spikeFactor =
    baselineRunRatePerHour !== null && baselineRunRatePerHour > 0 ? currentRunRatePerHour / baselineRunRatePerHour : null;
  const anomalousGrowth = spikeFactor !== null && spikeFactor > policy.spikeThresholdMultiplier;

  const remainingBudget = Math.max(0, policy.maxWeightedTokens7d - sums.totalWeightedTokens);

  if (!hardCapBreached && !anomalousGrowth) {
    const bucket = getWritableBucket(ledger, nowHourEpoch);
    bucket.weightedTokens += cost.weightedTotal;
    bucket.requestCount += 1;
    return { allowed: true, estimatedTokens: cost.weightedTotal, remainingBudget };
  }

  const projectedHoursToExhaustion =
    currentRunRatePerHour > 0 && !hardCapBreached
      ? (policy.maxWeightedTokens7d - sums.totalWeightedTokens) / currentRunRatePerHour
      : null;

  const projection: BudgetProjection = {
    windowUsageTokens: sums.totalWeightedTokens,
    limitTokens: policy.maxWeightedTokens7d,
    overageTokens: Math.max(0, totalAfterThisRequest - policy.maxWeightedTokens7d),
    requestTokens: cost.weightedTotal,
    currentRunRatePerHour,
    baselineRunRatePerHour,
    spikeFactor,
    projectedHoursToExhaustion,
    triggeredBy: hardCapBreached ? 'HARD_CAP' : 'ANOMALOUS_GROWTH_RATE',
  };

  return { allowed: false, estimatedTokens: cost.weightedTotal, remainingBudget, projection };
}

/**
 * Post-hoc reconciliation, called once a real upstream response is in
 * hand. Two things happen: the ledger gets trued up with the REAL output
 * size (the pre-call gate only had a projection to work with), and the
 * per-tool EMA that feeds FUTURE projections gets updated — this is what
 * lets estimateRequestCost's output projection actually earn the word
 * "calibrated" over time, rather than being a fixed guess forever.
 *
 * Takes the ORIGINAL `RequestCostEstimate` — the exact object
 * `estimateRequestCost` returned at gate-time, already threaded through
 * `checkBudget` — rather than re-deriving "what was projected" from
 * scratch here. That distinction matters: the per-tool EMA can (and will)
 * keep moving between gate-time and now as other calls to the same tool
 * complete, so re-reading "the current projection" at record-time would
 * silently true up against the WRONG number. Passing the original estimate
 * through is what makes this correct regardless of what else happens to
 * that tool's EMA in between.
 *
 * Only called for calls that actually succeeded (see call sites in
 * proxyInterceptor.ts) — a failed upstream call didn't return a real
 * result to measure, and typically returns a small error payload anyway,
 * so treating it as a zero-cost non-event is a reasonable simplification,
 * not an undercount that matters in practice.
 *
 * One accepted imprecision: the true-up delta is credited to whichever
 * hour is CURRENT when this runs, not necessarily the original request's
 * hour (if a call straddles an hour boundary during its own execution).
 * Upstream calls are timeout-capped at UPSTREAM_TIMEOUT_MS (seconds); hour
 * buckets are 3600s wide — the odds of that boundary actually being
 * crossed are small, and the resulting error is a few seconds' worth of
 * tokens landing one bucket over, which doesn't matter at 7-day
 * granularity. Not worth threading the original hourEpoch through to close.
 */
export async function recordActualUsage(
  teamId: string,
  toolName: string | undefined,
  originalEstimate: RequestCostEstimate,
  upstreamResponseValue: unknown,
  clock: Clock = realClock,
  profile: TokenCalibrationProfile = DEFAULT_CALIBRATION,
): Promise<void> {
  const actualOutputTokens = Math.ceil(estimateJsonTokens(upstreamResponseValue, profile));
  updateToolOutputProfile(toolName, actualOutputTokens);

  const outputDelta = (actualOutputTokens - originalEstimate.projectedOutputTokens) * env.OUTPUT_TOKEN_COST_WEIGHT;
  if (outputDelta === 0) return; // common enough (cold-start default matching, or a genuinely stable tool) to skip a write

  const ledger = getLedger(teamId);
  const nowHourEpoch = Math.floor(clock() / HOUR_MS);
  getWritableBucket(ledger, nowHourEpoch).weightedTokens += outputDelta;
  // Input tokens were measured exactly (not projected) at gate-time and
  // already correctly credited then — nothing to true up on that side.
}

/**
 * Records usage for a call that bypassed checkBudget entirely — the
 * Phase 5 human-in-the-loop APPROVE path (routes/resume.ts). This is
 * deliberately a DIFFERENT function from recordActualUsage, not a call to
 * it with a zero-projection estimate: recordActualUsage computes a DELTA
 * against an existing projected credit that checkBudget's allow branch
 * already wrote into the ledger. An approved-and-resumed call was never
 * gated, so nothing was ever written for it — there is no prior credit to
 * correct, only a full cost to add for the first time. Reusing
 * recordActualUsage here would silently under-count every resumed call's
 * INPUT-token cost (it only ever adjusts the output side, on the
 * assumption the input side was already credited correctly at gate-time —
 * an assumption that's simply false for a call that skipped the gate).
 *
 * Both input and output are measured EXACTLY here, not projected — unlike
 * the pre-call gate, this runs after the upstream call has already
 * completed, so the real response is already in hand.
 *
 * Still updates the per-tool output EMA, same as recordActualUsage, so an
 * approved call's real output size still improves future projections for
 * this tool.
 */
export async function recordApprovedUsage(
  teamId: string,
  toolName: string | undefined,
  originalRequestBody: JsonRpcRequest,
  upstreamResponseValue: unknown,
  clock: Clock = realClock,
  profile: TokenCalibrationProfile = DEFAULT_CALIBRATION,
): Promise<void> {
  const inputTokens = Math.ceil(estimateJsonTokens(originalRequestBody, profile) + profile.perCallOverheadTokens);
  const actualOutputTokens = Math.ceil(estimateJsonTokens(upstreamResponseValue, profile));
  updateToolOutputProfile(toolName, actualOutputTokens);

  const weightedTotal = Math.ceil(inputTokens + actualOutputTokens * env.OUTPUT_TOKEN_COST_WEIGHT);

  const ledger = getLedger(teamId);
  const nowHourEpoch = Math.floor(clock() / HOUR_MS);
  const bucket = getWritableBucket(ledger, nowHourEpoch);
  bucket.weightedTokens += weightedTotal;
  bucket.requestCount += 1;
}
