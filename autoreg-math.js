'use strict';

/* ============================================================
   AUTOREG — Autoregulation Math (pure, side-effect-free)

   Every function here is a pure function of its arguments: no State, no
   DOM, no IndexedDB, no Date-of-now. That's the whole point — this is the
   highest cost-of-bug surface in the app (e1RM, weight prescription,
   warm-up ramps), so it's isolated here where it can be unit-tested in
   Node with zero dependencies and zero build step.

   Dual-loads: in the browser this is a classic <script> and every symbol
   becomes a global (same model as the rest of the app). In Node it's a
   CommonJS module — see the export footer at the bottom. Nothing above the
   footer references `module`, `window`, or any host global, so requiring
   it from a test file is safe.
   ============================================================ */

/* ---------------- Primitive helpers ---------------- */

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function roundToIncrement(weight, increment) {
  return Math.round(weight / increment) * increment;
}

/* ---------------- e1RM estimation ---------------- */

// Epley estimated 1RM from a straight set. Only used as a fallback basis;
// the reps-to-failure table below is the primary path.
function epley1RM(weight, reps) {
  if (reps <= 1) return weight;
  return weight * (1 + reps / 30);
}

// Reps-in-reserve implied by an RPE (RPE 8 => 2 in the tank), floored at 0.
function rirFromRPE(rpe) { return clamp(10 - rpe, 0, 10); }

// Brzycki-style %1RM indexed by reps-to-failure (reps performed + RIR).
// Keys cover 1..15; e1RMFromSet/prescribeWeight clamp their lookups into
// this range, so the table is always hit and the "|| fallback" arms below
// are unreachable-by-construction (locked by a test so a future change to
// the clamp bounds can't silently activate an untested branch).
const PCT_1RM_BY_REPS_TO_FAILURE = {
  1: 1.00, 2: 0.955, 3: 0.922, 4: 0.892, 5: 0.863,
  6: 0.837, 7: 0.811, 8: 0.786, 9: 0.762, 10: 0.739,
  11: 0.717, 12: 0.695, 13: 0.674, 14: 0.653, 15: 0.633,
};

// Back-calculate e1RM from a top set logged at a given weight/reps/RPE.
function e1RMFromSet(weight, reps, rpe) {
  const repsToFailure = clamp(Math.round(reps + rirFromRPE(rpe)), 1, 15);
  const pct = PCT_1RM_BY_REPS_TO_FAILURE[repsToFailure] || (epley1RM(weight, reps) && (weight / epley1RM(weight, reps)));
  return weight / pct;
}

/**
 * Prescribed weight for a target rep count + target RPE off a known e1RM,
 * rounded to the user's minimum increment and floored at one increment so
 * a suggestion is never zero/negative.
 */
function prescribeWeight(e1rm, targetReps, targetRPE, increment) {
  const repsToFailure = clamp(Math.round(targetReps + rirFromRPE(targetRPE)), 1, 15);
  const pct = PCT_1RM_BY_REPS_TO_FAILURE[repsToFailure] || 0.75;
  const raw = e1rm * pct;
  return Math.max(increment, roundToIncrement(raw, increment));
}

/**
 * Exponential smoothing of a lift's rolled-forward e1RM. 60% weight to the
 * newest data point: responsive, but one off session can't whiplash the
 * working max. First-ever point (no prior) is taken as-is.
 */
function rollForwardE1RM(previousE1RM, newSetE1RM) {
  if (!previousE1RM || previousE1RM <= 0) return newSetE1RM;
  const ALPHA = 0.6;
  return previousE1RM * (1 - ALPHA) + newSetE1RM * ALPHA;
}

/* ---------------- Block-phase training RPE ---------------- */

const BLOCK_PHASE_TRAINING_RPE_COMPOUND = { Accumulation: 7, Intensification: 8, Max: 10, Deload: 5 };
// Isolation runs one RPE hotter than compound at every phase (lower
// systemic fatigue cost), computed from the compound table so the two
// can't drift out of that +1 relationship — clamped at 10 (Max compound is
// already the ceiling, there's no RPE 11).
const BLOCK_PHASE_TRAINING_RPE_ISOLATION = Object.fromEntries(
  Object.entries(BLOCK_PHASE_TRAINING_RPE_COMPOUND).map(([phase, rpe]) => [phase, Math.min(10, rpe + 1)])
);

// Pure phase -> RPE lookup. The app's getPhaseTrainingRPE() wrapper feeds
// this the CURRENT block phase; kept separate so the table logic is
// testable without a live block/State.
function phaseTrainingRPE(phase, isCompound) {
  const table = isCompound ? BLOCK_PHASE_TRAINING_RPE_COMPOUND : BLOCK_PHASE_TRAINING_RPE_ISOLATION;
  return table[phase] ?? 8;
}

/* ---------------- Warm-up ramp ---------------- */

// Fixed ramp shape (percent of the projected top working weight). Warm-up
// SHAPE doesn't need per-template tuning the way reps/sets do.
const DEFAULT_WARMUP_STEPS = [{ reps: 5, pct: 50 }, { reps: 3, pct: 65 }, { reps: 2, pct: 80 }];

/**
 * Generate warm-up ramp rows for a projected top working weight. Returns
 * one { reps, pct, weight } per step. With no projected top yet (a lift
 * with no e1RM basis), weights come back null — the rows still exist (the
 * person warms up by feel), they just carry no auto-filled load. Never
 * produces NaN.
 */
function buildWarmupRamp(projectedTop, increment, steps) {
  const ramp = steps || DEFAULT_WARMUP_STEPS;
  return ramp.map((step) => ({
    reps: step.reps,
    pct: step.pct,
    weight: (projectedTop && projectedTop > 0)
      ? roundToIncrement(projectedTop * (step.pct / 100), increment)
      : null,
  }));
}

/* ---------------- Drop sets & missed-rep safety ---------------- */

// A drop set steps down a modest, fixed amount from the set before it.
const DROPSET_STEP_PCT = 0.9;

function dropsetStepWeight(prevWeight, increment) {
  return roundToIncrement(prevWeight * DROPSET_STEP_PCT, increment);
}

// When a basis set came in UNDER its target reps, self-rated RPE is least
// trustworthy (last reps are hardest to judge, people under-report how
// close to failure they were), so pull the next suggestion down further
// than the RPE math alone: 2% per rep short, scaling CONTINUOUSLY with the
// size of the miss (no fixed rep-count cap) so a catastrophic miss (4 of
// 12 target reps) gets proportionally more caution than a small one (10 of
// 12) instead of both being treated the same. The overall discount is
// capped at MISSED_REP_SAFETY_MAX_PCT so a huge miss can pull the
// prescription down hard without being able to wipe it out entirely.
const MISSED_REP_SAFETY_PCT = 0.02;
const MISSED_REP_SAFETY_MAX_PCT = 0.30;

function applyMissedRepSafety(weight, targetRepsLow, basisReps, increment) {
  const missedReps = Math.max(0, targetRepsLow - basisReps);
  if (missedReps <= 0) return weight;
  const discountPct = Math.min(MISSED_REP_SAFETY_MAX_PCT, MISSED_REP_SAFETY_PCT * missedReps);
  return Math.max(increment, roundToIncrement(weight * (1 - discountPct), increment));
}

/* ---------------- Plate math ---------------- */

const STANDARD_PLATES = [45, 35, 25, 10, 5, 2.5];

/**
 * Per-side plate breakdown for a target barbell weight. `remainder` is
 * whatever can't be made exactly with the available plates (surfaced so
 * the UI can flag an unachievable-exact target instead of silently
 * rounding).
 */
function calculatePlateBreakdown(totalWeight, barWeight) {
  const bar = barWeight == null ? 45 : barWeight;
  let perSide = Math.max(0, (totalWeight - bar) / 2);
  const breakdown = [];
  for (const plate of STANDARD_PLATES) {
    const count = Math.floor((perSide + 1e-9) / plate);
    if (count > 0) {
      breakdown.push({ plate, count });
      perSide -= count * plate;
    }
  }
  return { bar, perSide: breakdown, remainder: Math.round(perSide * 100) / 100 };
}

/* ---------------- Assisted bodyweight ---------------- */

// For an assisted-bodyweight exercise (e.g. an assisted pull-up/dip
// machine), the number entered isn't added load — it's how much of the
// person's own bodyweight the machine is offsetting. Effective load is
// therefore INVERTED from a normal lift: more assistance = less
// resistance. These two functions are the only place that inversion
// happens; every other math function (e1RM, prescription, drop-set step,
// missed-rep safety, warm-up ramp) keeps working purely in "effective
// load" terms and never needs to know assisted mode exists — callers
// convert at the boundary (log a set -> effective load in; prescribe a
// number -> assistance out).

function assistedEffectiveLoad(bodyweight, assistanceWeight) {
  return Math.max(0, bodyweight - (assistanceWeight || 0));
}

/**
 * Inverse of assistedEffectiveLoad: given a prescribed EFFECTIVE load,
 * backs it out into the assistance number to dial in on the machine.
 * Clamped to [0, bodyweight] — assistance can't go negative (that's a
 * weighted rep, a different exercise) and can't exceed total bodyweight
 * (zero effective load is the floor of what this mode represents).
 */
function assistedDialIn(bodyweight, effectiveLoad, increment) {
  const raw = bodyweight - effectiveLoad;
  return clamp(roundToIncrement(raw, increment), 0, bodyweight);
}

/* ---------------- Rest timer ---------------- */

/**
 * Rest time is driven by the ACTUAL reps just performed, not by whether
 * the lift is classified compound or isolation. A rep count is a much
 * more direct signal of how heavy/fatiguing a set really was than a fixed
 * per-lift label — and it sidesteps the problem a compound/isolation
 * split has, where plenty of real accessories (leg press, incline
 * dumbbell press, barbell RDL) are compound by definition while still
 * being submaximal, higher-rep work that doesn't need long rest.
 *
 * 5 reps or fewer (near-max singles/doubles/triples territory) get
 * generous rest that scales up to a full 5 minutes at RPE 10 — genuinely
 * grinding a low-rep set at max effort calls for real recovery. More than
 * 5 reps is capped at 120 seconds even at RPE 10 — a hard high-rep set is
 * real fatigue, but not the kind that calls for multi-minute breaks the
 * way a near-max low-rep attempt does.
 */
function restSecondsForRPE(rpe, isWarmup, reps) {
  if (isWarmup) return 30;
  if (reps != null && reps > 5) {
    if (rpe == null) return 75;
    if (rpe >= 9) return 120;
    if (rpe >= 7) return 90;
    return 60;
  }
  // 5 reps or fewer — including an unknown rep count, where the safer
  // default is to assume it might be heavy and rest longer, not shorter.
  if (rpe == null) return 120;
  if (rpe >= 10) return 300;
  if (rpe >= 9) return 210;
  if (rpe >= 7) return 150;
  return 90;
}

/* ---------------- Effort tiers (simplified RPE input) ---------------- */

/**
 * Five named effort levels replace typing a precise decimal RPE — mid-set,
 * nobody can reliably tell a 7 from a 7.5. Each tier has a representative
 * RPE value used internally by all the existing prescription/e1RM math
 * (which stays numeric and unchanged); the tiers are just a friendlier
 * input/display layer on top of it. `rangeLabel` is what a person sees
 * ("5–6"); the actual categorization cutoffs below are a half-point off
 * the plain-language ranges only where needed to keep them non-overlapping
 * (e.g. Easy and Moderate both plausibly "contain" 6 in casual speech —
 * 6 has to land in exactly one bucket for the math to be well-defined).
 */
const EFFORT_TIERS = [
  { id: 'effortless', label: 'Effortless', abbr: 'Eff',  rangeLabel: 'Under 5', rpe: 4 },
  { id: 'easy',       label: 'Easy',       abbr: 'Easy', rangeLabel: '5–6',     rpe: 5.5 },
  { id: 'moderate',   label: 'Moderate',   abbr: 'Mod',  rangeLabel: '6–7',     rpe: 7 },
  { id: 'hard',       label: 'Hard',       abbr: 'Hard', rangeLabel: '8–9',     rpe: 8.5 },
  { id: 'maximal',    label: 'Maximal',    abbr: 'Max',  rangeLabel: '10',     rpe: 10 },
];

/** Numeric RPE -> tier id. Null/undefined in, null out — there's no tier
 *  for "no rating yet" (that's what N/A on a warm-up means). */
function rpeToEffortTier(rpe) {
  if (rpe == null) return null;
  if (rpe < 5) return 'effortless';
  if (rpe < 6.5) return 'easy';
  if (rpe < 8) return 'moderate';
  if (rpe < 9.5) return 'hard';
  return 'maximal';
}

/** Tier id -> its representative numeric RPE, for feeding into the
 *  unchanged prescription/e1RM math. Unknown id -> null. */
function effortTierToRPE(tierId) {
  const tier = EFFORT_TIERS.find((t) => t.id === tierId);
  return tier ? tier.rpe : null;
}

/* ---------------- Readiness modulation ---------------- */

/**
 * Turns the daily check-in (sleep / stress / feeling, each 1–10) plus the
 * HRV readiness zone into a single load multiplier applied to every
 * HISTORY-BASED prescription for the session (the projected top weight and
 * the first-set autofill). It is deliberately NOT applied to within-session
 * suggestions: once a real set is logged, its RPE already reflects today's
 * readiness, and multiplying again would double-count the same signal.
 *
 * Shape: each provided subjective metric normalizes to [-1, 1] around its
 * 5.5 midpoint (stress inverted — high stress is bad), the average scales
 * a ±4% swing, and the HRV zone layers a small penalty on top (never a
 * bonus — a good HRV trend earns you "no penalty", not free kilos). The
 * final multiplier is clamped to [0.92, 1.02]: a rough day can pull a
 * prescription down a meaningful-but-recoverable 8%, while a great day
 * only nudges it up 2% — the asymmetry is intentional, since overshooting
 * on a "feel great" day costs more than undershooting on one.
 *
 * Null-tolerant everywhere: missing metrics simply don't vote, and no
 * check-in at all returns exactly 1 (the engine behaves as if readiness
 * modulation doesn't exist until the person gives it a signal).
 */
const READINESS_LOAD_FLOOR = 0.92;
const READINESS_LOAD_CEILING = 1.02;
const READINESS_SUBJECTIVE_SWING = 0.04;
const READINESS_HRV_PENALTY = { fresh: 0, mid: -0.01, hard: -0.03, unknown: 0 };

function readinessLoadMultiplier(sleep, stress, feeling, hrvZone) {
  const votes = [];
  if (sleep != null) votes.push(clamp((sleep - 5.5) / 4.5, -1, 1));
  if (feeling != null) votes.push(clamp((feeling - 5.5) / 4.5, -1, 1));
  if (stress != null) votes.push(clamp((5.5 - stress) / 4.5, -1, 1));
  const subjective = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : 0;
  const hrvAdj = READINESS_HRV_PENALTY[hrvZone] ?? 0;
  const raw = 1 + subjective * READINESS_SUBJECTIVE_SWING + hrvAdj;
  return clamp(Math.round(raw * 1000) / 1000, READINESS_LOAD_FLOOR, READINESS_LOAD_CEILING);
}

/* ---------------- Volume landmarks (MEV / MAV / MRV) ---------------- */

/**
 * Renaissance-Periodization-style weekly volume landmarks per muscle group,
 * derived from the lifter's own maximum adaptive volume (MAV — in this app,
 * the auto-generated trailing-average target from getAutoVolumeTargets()):
 *   MEV (minimum effective)    = 60% of MAV — below this, maintenance only
 *   MAV (maximum adaptive)     = the trailing-average target itself
 *   MRV (maximum recoverable)  = 130% of MAV — above this, recovery debt
 * Deriving from the person's own demonstrated volume rather than population
 * literature keeps the landmarks personal and self-correcting: train more
 * for six weeks and the whole band shifts up with you.
 */
const VOLUME_MEV_RATIO = 0.6;
const VOLUME_MRV_RATIO = 1.3;

function volumeLandmarks(mav) {
  const round05 = (v) => Math.max(0.5, Math.round(v * 2) / 2);
  return { mev: round05(mav * VOLUME_MEV_RATIO), mav: round05(mav), mrv: round05(mav * VOLUME_MRV_RATIO) };
}

/**
 * Which landmark band a week's current effective volume sits in:
 *   'below-mev' — not enough stimulus to adapt; room (and reason) to add
 *   'adaptive'  — MEV..MAV, the productive growth zone; room to add
 *   'high'      — MAV..MRV, productive but eating into recovery; hold
 *   'over-mrv'  — beyond recoverable; actively cut
 */
function volumeZone(current, landmarks) {
  if (current < landmarks.mev) return 'below-mev';
  if (current < landmarks.mav) return 'adaptive';
  if (current <= landmarks.mrv) return 'high';
  return 'over-mrv';
}

/* ---------------- Set-count autoregulation ---------------- */

/**
 * The per-exercise "should today have one more or one fewer set?" decision,
 * made the moment a working set completes. Inputs are the just-logged set's
 * actual RPE vs the phase target, how many reps it missed, the muscle
 * group's current weekly volume zone, and the block phase.
 *
 * Returns -1 / 0 / +1:
 *   -1 (cut a remaining set) when the set ran ≥1.5 RPE hotter than target,
 *      missed ≥2 reps, or the group is already over MRV — all three are
 *      "the dose is exceeding the day", and volume is the right dial to
 *      turn down (the load dial is already handled by missed-rep safety
 *      and the RPE-based next-set prescription).
 *   +1 (add a set) only when the set came in ≥1.5 RPE EASIER than target
 *      AND the group still has room below MAV — cheap extra stimulus on a
 *      day the body is clearly ahead of the plan. Never during Deload
 *      (defeats the purpose) or Max (peaking blocks trade volume for
 *      intensity on purpose).
 *    0 otherwise — the plan stands.
 *
 * Cut checks run before phase gating: a Deload set that misses badly should
 * still shed volume. Add checks run after: easy sets during Deload are the
 * whole point, not an invitation.
 */
const SET_ADD_RPE_HEADROOM = 1.5;
const SET_CUT_RPE_OVERSHOOT = 1.5;
const SET_CUT_MISSED_REPS = 2;
const SET_ADD_BLOCKED_PHASES = ['Deload', 'Max'];

function recommendSetDelta(lastRPE, targetRPE, missedReps, zone, phase) {
  if (lastRPE == null || targetRPE == null) return 0;
  if ((missedReps || 0) >= SET_CUT_MISSED_REPS) return -1;
  if (lastRPE >= targetRPE + SET_CUT_RPE_OVERSHOOT) return -1;
  if (zone === 'over-mrv') return -1;
  if (SET_ADD_BLOCKED_PHASES.includes(phase)) return 0;
  if (lastRPE <= targetRPE - SET_ADD_RPE_HEADROOM && (zone === 'below-mev' || zone === 'adaptive')) return 1;
  return 0;
}

/* ---------------- Node export footer (no-op in the browser) ---------------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clamp, roundToIncrement,
    epley1RM, rirFromRPE, PCT_1RM_BY_REPS_TO_FAILURE, e1RMFromSet, prescribeWeight, rollForwardE1RM,
    BLOCK_PHASE_TRAINING_RPE_COMPOUND, BLOCK_PHASE_TRAINING_RPE_ISOLATION, phaseTrainingRPE,
    restSecondsForRPE,
    EFFORT_TIERS, rpeToEffortTier, effortTierToRPE,
    DEFAULT_WARMUP_STEPS, buildWarmupRamp,
    DROPSET_STEP_PCT, dropsetStepWeight, MISSED_REP_SAFETY_PCT, MISSED_REP_SAFETY_MAX_PCT, applyMissedRepSafety,
    STANDARD_PLATES, calculatePlateBreakdown,
    assistedEffectiveLoad, assistedDialIn,
    READINESS_LOAD_FLOOR, READINESS_LOAD_CEILING, READINESS_SUBJECTIVE_SWING, READINESS_HRV_PENALTY, readinessLoadMultiplier,
    VOLUME_MEV_RATIO, VOLUME_MRV_RATIO, volumeLandmarks, volumeZone,
    SET_ADD_RPE_HEADROOM, SET_CUT_RPE_OVERSHOOT, SET_CUT_MISSED_REPS, SET_ADD_BLOCKED_PHASES, recommendSetDelta,
  };
}
