# AutoReg — Simplified

One idea: **the engine owns the plan; you report actual vs planned.** Every feature that wasn't in service of that got cut. The elite progression model — the part that took months to get right — is intact and still fully unit-tested.

## The progression model (kept, whole)
1. **e1RM roll-forward** — every logged working set back-calculates an implied 1RM through the reps-to-failure table; a 60/40 exponential smooth keeps the working max responsive without one bad session whiplashing it.
2. **RPE prescription** — every load in the app is prescribed from the current e1RM for the target reps at the phase's training RPE, rounded to your plate increment.
3. **Block periodization** — Accumulation → Intensification → Max → Deload auto-distributed over your cycle length (anchor which week you're on in Settings). Phase drives target RPE (compound: 7/8/10/5; isolation runs +1, capped at 10).
4. **Daily readiness → load** — one tap (Rough → Great) becomes a 0.92–1.02 multiplier on every history-based prescription, warm-up ramp included. Applied once at session start; never re-applied to within-session suggestions, whose logged RPEs already embed today's readiness. Older check-ins recorded by the full app (sleep/stress/feeling) still vote.
5. **Within-session correction** — the most recent completed working set re-prescribes every set after it from its implied e1RM; a set that misses reps layers 2%-per-rep safety (capped 30%) on top.
6. **Set-count autoregulation** — a working set ≥1.5 RPE hot or ≥2 reps short cuts a remaining set; a final set ≥1.5 RPE easy adds one (never during Deload/Max). One adjustment per exercise, always a toast with one-tap Undo.
7. **Warm-up ramp, rep-based rest, plate math** — the ramp scales to the readiness-adjusted top; rest keys off actual reps+RPE; barbell compounds show a per-side plate hint inline.

## What got cut
Template folders and all drag gestures, the Coach tab, HRV tracking, the joint/tendon symptom tracker, per-muscle-group volume dashboards and MEV/MAV/MRV accounting, drop sets, cloud backup + serverless functions, onboarding, the Lifts tab, charts. ~6,000 lines → ~2,300 across three runtime files.

## Architecture
- **`autoreg-math.js`** — unchanged. Every prescription/e1RM/readiness/set-delta decision is a pure function here, covered by `tests/math.test.js`.
- **`autoreg-migrations.js`** — unchanged mechanism; **migration v10** folds the old active folder's day slots into `settings.weeklyPlan` ({dow → templateId}), non-destructively.
- **`app.js`** — everything else: the same IndexedDB schema and record shapes as the full app (existing history loads as-is; a backup from either version restores into the other), the block clock, the session engine wiring, and three screens (Today / Plan / History) plus a Settings sheet with keyless local JSON export/import.
- **Data compatibility is a hard constraint.** Same DB name, stores, keyPaths, and session/template/lift/settings shapes. The full app's data runs here after v10; sessions logged here read fine back there.

## Tests
`npm test` — 98 unit tests (math + migrations), zero deps, `node --test`. `node tests/app.smoke.js` — loads the real math + app in a vm with a fake DOM and drives readiness → prescription, the warm-up ramp, set add/cut, Undo, the one-shot guard, and the Deload gate end to end.

## Target Intensity override
Every prescription's target RPE defaulted to the block phase (compound/isolation split) with no way to dial it for a specific session. Added a **Target Intensity** control to the active workout screen — a chip under the workout name reads "Target RPE 7–8 · Accumulation default" (or "Target RPE 9.5 · Custom" once set); tapping it opens a stepper (0.5 increments, RPE 5–10) with a "Use block default" reset.

- **Session-scoped, not persistent by design.** The override lives on `State.activeWorkout.rpeOverride` — nowhere else — so every new workout starts back at the block-phase default, matching "the default being by what week of a block you are in." It rides along into the saved session record for the same reason the readiness snapshot does: a permanent note of what target the workout was actually lifted under.
- **Applies going forward, not retroactively.** Setting it re-derives every exercise's projected top and not-yet-completed warm-up weights immediately (`applyIntensityOverride()` → `recomputeExerciseTargets()` per exercise) — already-logged sets are untouched. Exercises added to the workout after the override is set inherit it too.
- **Replaces, doesn't offset.** An override sets ONE RPE for every exercise, compound and isolation alike — the phase table's usual isolation-runs-hotter split is a default, not a rule, and an explicit override is the person overriding both branches at once.
- **Tests** — `tests/app.smoke.js` scenario 7 drives the whole path: default RPE before any override, override applied to an existing exercise and to one added afterward, and clearing it drops the projected top back down.

## Lift-aware load jumps
Every prescription's rounding step was one flat number (`settings.minIncrement`, default 5lb) applied to every lift alike — a squat and a gripper got jumped by the same amount for the same "easy" or "hard" signal, which doesn't reflect how differently those lifts actually load. Autoregulation is now lift-aware:

- **Two category defaults** replace the flat one: `settings.compoundIncrement` (default 5lb — barbell whole-plate math) and `settings.isolationIncrement` (default 2.5lb — cable/machine/accessory/grip work, adjustable in finer steps and lower-stakes per jump). Both editable in Settings under "Load jumps."
- **Per-lift override** — any lift, preset or custom, can pin its own exact jump size from an Edit-lift form (a pencil icon next to every result in the lift picker), for anything that doesn't fit its category default — a specific fixed-increment gripper, a machine with coarse pins. Blank = inherit the category default.
- **`getLiftIncrement(lift)`** is the single source of truth: per-lift override → else category default by `isCompound` → else a hard fallback (5/2.5), so rounding can never divide by zero. Every prescription site (projected top, warm-up ramp, in-session re-prescription, missed-rep safety, autofill, readiness scaling) now derives its increment from the exercise's own lift instead of one global constant — `autoreg-math.js` itself needed zero changes, since every function there already took `increment` as a parameter.
- **Transparency** — the active-exercise card's meta line now shows the live jump size ("5×5 reps @ RPE 7 · e1RM 320 · jump 2.5") so it's visible which grid a lift is prescribing against.
- **Migration v11** splits the old flat `minIncrement` into both new fields seeded from the SAME value, so an upgraded install's prescriptions are numerically identical until the person opens Settings or a lift's Edit form and actually gives one category (or one lift) a different number.
- **Tests** — 3 new migration tests (101 total) cover the split, the fresh-install no-op, and the re-run self-guard. `tests/app.smoke.js` scenario 8 proves a compound and an isolation lift round to different grids by default from the same basis set and target, and that a per-lift override wins outright.

## Smart sets/reps defaults in the template builder
Adding an exercise to a template used to drop in the same flat guess every time — 3 sets × 5–8 reps — regardless of whether it was a squat or a lateral raise, leaving every single addition needing a manual fix. `defaultTemplateExercise(liftId)` now tiers the starting sets/reps by the lift's role, so most additions need no editing at all — the fields are still fully editable for the exceptions:

- **Primary pull** (Deadlift, Sumo Deadlift — highest fatigue cost) → 3×2–3
- **Primary lift** (Squat/Bench/Press family, by name) → 4×3–5
- **Other compound** (any other `isCompound` lift — secondary/assistance movements) → 3×6–8
- **Isolation/accessory** → 3×10–12

Warm-up still defaults on for anything compound, off for isolation — unchanged rule. The "primary" tier is a short, explicit name list (`PRIMARY_LIFT_NAMES`/`PRIMARY_PULL_LIFT_NAMES`) rather than an inferred property, since nothing on a lift record signals "how central is this lift" beyond its name; every custom lift and anything unlisted falls back cleanly to the compound/isolation split. Preset templates (`PRESET_TEMPLATES`) are untouched — their numbers are already hand-tuned per exercise and per program context (e.g. Front Squat at 3×5–5 specifically as SBD Deadlift-day volume work, which the generic default would get wrong) — this only changes what a freshly-added exercise starts at while you're building a template yourself.

**Tests** — `tests/app.smoke.js` scenario 9 checks all four tiers plus the unrecognized-custom-lift fallback.

## Quick fix: reps target locking to a truncated keystroke
When an exercise is added mid-workout (not from a template), it starts with no set target — typing reps into its first set is supposed to establish that target once, for the whole exercise, which every other set's reps placeholder and autofill-on-complete then reads. That establishment ran on the input's `input` event, which fires on every keystroke — so typing a two-digit rep count like "12" locked the target the instant the "1" landed, and the second keystroke never got a chance to correct it. Every other set then showed and auto-filled to that wrong, truncated number, which read exactly like "changing reps on one set changes all the sets below it."

Fixed by splitting the two responsibilities across the two events they actually belong to: `input` still updates the set's own live value on every keystroke; establishing the exercise-wide target now runs on `change` (fires once, on blur, with the final committed value) instead. Same one-time-only establishment behavior, correct number.

**Tests** — `tests/app.smoke.js` scenario 10 is a regression guard for the exact failure mode: simulates sequential live writes (1, then 12) followed by a single final-value establishment, and asserts the target lands on 12, not 1.

## GitHub → Cloudflare Pages deploy pipeline
Added a GitHub Actions workflow (`.github/workflows/deploy.yml`) so pushing to `main` tests and deploys automatically — no manual zip/upload step.

- **Every push and pull request** runs the full test suite (101 unit tests + `tests/app.smoke.js`) via `actions/setup-node` + `npm test`.
- **Push to `main` only, gated on tests passing** (`needs: test`): collects the app's actual deployable files — `index.html`, `styles.css`, `app.js`, `autoreg-math.js`, `autoreg-migrations.js`, `manifest.json`, `sw.js`, `icons/` — into a `dist/` folder (no bundler needed, the app has no build step) and publishes it with Cloudflare's official `wrangler-action`. `tests/`, `package.json`, and the docs never reach the deployed site.
- Needs two GitHub repo secrets one time: `CLOUDFLARE_API_TOKEN` (an Account → Cloudflare Pages → Edit token) and `CLOUDFLARE_ACCOUNT_ID`. Full walkthrough in `DEPLOY.md`. First deploy auto-creates the `autoreg` Cloudflare Pages project if it doesn't already exist.
- `package.json` cleaned up alongside this — dropped the stale `@netlify/blobs` dependency and description left over from the pre-simplification cloud-backup feature (long since removed), and added an `npm run smoke` script for the smoke suite.
- Added `.gitignore` (`node_modules/`, `dist/`, `.wrangler/`) now that this is a proper git repo.
