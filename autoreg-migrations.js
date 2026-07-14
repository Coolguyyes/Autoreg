'use strict';

/* ============================================================
   AUTOREG — Versioned Data Migrations (pure)

   Ordered, once-only transforms of stored record shapes. Each migration's
   `version` is the userDataVersion it upgrades the store TO. The runner (in
   app.js) applies every migration whose version exceeds the stored one, in
   ascending order — the stored version is the run-gate. This replaces the
   old approach of deciding whether to run by sniffing data shape, which is
   what caused the load-order folder-orphaning bug (a shape guard read
   settings before they were loaded, so it re-ran every boot).

   Each migrate(ctx) is a PURE transform over an in-memory snapshot:
     ctx.lifts / sessions / templates / checkins / symptoms — arrays; mutate
         records in place.
     ctx.settings — the settings object; mutate in place.
     ctx.deps.{ DEFAULT_LIFTS, LEGACY_GROUP_FALLBACK, uid } — injected by the
         runner so this file stays free of app/DOM/DB globals and is
         unit-testable in Node.
     ctx.write(store, record) — queue a record upsert; the runner flushes.
     ctx.touchSettings() — mark the settings row dirty; the runner persists.

   Migrations keep their original internal self-guards as defense-in-depth.
   On the first boot after versioning ships, an already-migrated install
   runs them one last time (version 0 -> LATEST) and the guards no-op. New
   migrations may rely on the version gate, but SHOULD still be idempotent:
   the runner commits the version per-step, so a crash mid-sequence re-runs
   only the interrupted step.

   TO ADD A MIGRATION: append an entry to MIGRATIONS with the next version
   number and a migrate(ctx) that transforms old shapes to new. Never
   renumber or reorder existing entries. That's the whole extension story —
   no hand-ordered call sequence to get wrong.

   Dual-loads: classic <script> in the browser (symbols become globals),
   CommonJS module in Node (export footer at the bottom).
   ============================================================ */

/**
 * v1 — Upgrade lifts from the old single-`group` string to the multi-label
 * `groups` array. Presets map precisely from DEFAULT_LIFTS by name; anything
 * else falls back to a coarse mapping off its old broad group so volume
 * tracking keeps working until the user fine-tunes it.
 */
function migrateLiftGroups(ctx) {
  const { DEFAULT_LIFTS, LEGACY_GROUP_FALLBACK } = ctx.deps;
  for (const lift of ctx.lifts) {
    if (Array.isArray(lift.groups) && lift.groups.length > 0) continue; // self-guard
    const preset = !lift.custom && DEFAULT_LIFTS.find((d) => d.name === lift.name);
    lift.groups = preset
      ? preset.groups.map((g) => ({ ...g }))
      : (LEGACY_GROUP_FALLBACK[lift.group] || []).map((g) => ({ ...g }));
    delete lift.group;
    ctx.write('lifts', lift);
  }
}

/**
 * v2 — Backfill isCompound onto preset lifts saved before the field existed,
 * matching by name against DEFAULT_LIFTS. Custom lifts are left alone
 * (getLiftIsCompound() defaults them to isolation until classified).
 */
function migrateLiftCompound(ctx) {
  const { DEFAULT_LIFTS } = ctx.deps;
  for (const lift of ctx.lifts) {
    if (lift.custom || typeof lift.isCompound === 'boolean') continue; // self-guard
    const preset = DEFAULT_LIFTS.find((d) => d.name === lift.name);
    if (!preset) continue;
    lift.isCompound = preset.isCompound;
    ctx.write('lifts', lift);
  }
}

/**
 * v3 — Move to the dynamic folder model. Folders used to be a fixed 3-value
 * string on each template, with day-assignment on the template itself.
 * Folders are now first-class entities owning both member order and the
 * day->template schedule. Creates the three default folders (this is also
 * what a fresh install relies on to have folders at all), assigns every
 * template a folderId + order, folds old per-template days into the folder
 * schedule, and drops the retired settings keys.
 */
function migrateTemplateFolders(ctx) {
  if (Array.isArray(ctx.settings.templateFolders)) return; // self-guard
  const { uid } = ctx.deps;

  const names = ['Powerlifting', 'Bodybuilding', 'My Templates'];
  const folders = names.map((name, i) => ({ id: uid(), name, order: i, active: false, days: {} }));
  const byName = {};
  folders.forEach((f) => { byName[f.name] = f; });
  const orderCounters = {};
  folders.forEach((f) => (orderCounters[f.id] = 0));

  for (const t of ctx.templates) {
    const folder = byName[t.folder] || byName['My Templates'];
    t.folderId = folder.id;
    t.order = orderCounters[folder.id]++;
    (t.days || []).forEach((dow) => { folder.days[dow] = t.id; });
    ctx.write('templates', t);
  }

  const prevActiveName = ctx.settings.activeTemplateFolder;
  if (prevActiveName && byName[prevActiveName]) byName[prevActiveName].active = true;

  ctx.settings.templateFolders = folders;
  delete ctx.settings.activeTemplateFolder;
  delete ctx.settings.weekFolders;
  delete ctx.settings.activeWeekFolderId;
  ctx.touchSettings();
}

/**
 * v4 — Strip retired per-exercise fields: manual targetRPE (now derived from
 * block phase) and warmupSteps arrays (now a warmupEnabled toggle).
 */
function migrateTemplateAutoRPE(ctx) {
  for (const t of ctx.templates) {
    let changed = false;
    for (const ex of t.exercises || []) {
      if ('targetRPE' in ex) { delete ex.targetRPE; changed = true; }
      if (Array.isArray(ex.warmupSteps)) {
        ex.warmupEnabled = ex.warmupSteps.length > 0;
        delete ex.warmupSteps;
        changed = true;
      } else if (ex.warmupEnabled === undefined) {
        ex.warmupEnabled = false;
        changed = true;
      }
    }
    if (changed) ctx.write('templates', t);
  }
}

/**
 * v5 — Backfill practiceMode: false onto template exercises that predate
 * the practice-mode feature, same pattern as the v4 warmupEnabled backfill.
 * New exercises are created with practiceMode explicitly set, so this only
 * matters for pre-existing templates.
 */
function migratePracticeMode(ctx) {
  for (const t of ctx.templates) {
    let changed = false;
    for (const ex of t.exercises || []) {
      if (ex.practiceMode === undefined) { ex.practiceMode = false; changed = true; }
    }
    if (changed) ctx.write('templates', t);
  }
}

/**
 * v6 — Backfill assistedMode: false onto template exercises that predate
 * the assisted-bodyweight feature, same pattern as v5's practiceMode
 * backfill. New exercises are created with assistedMode explicitly set, so
 * this only matters for pre-existing templates.
 */
function migrateAssistedMode(ctx) {
  for (const t of ctx.templates) {
    let changed = false;
    for (const ex of t.exercises || []) {
      if (ex.assistedMode === undefined) { ex.assistedMode = false; changed = true; }
    }
    if (changed) ctx.write('templates', t);
  }
}

/**
 * v7 — Backfill accessoryMode: false onto template exercises that predate
 * the accessory-tiering feature, same pattern as v5/v6. New exercises are
 * created with accessoryMode explicitly set, so this only matters for
 * pre-existing templates.
 */
function migrateAccessoryMode(ctx) {
  for (const t of ctx.templates) {
    let changed = false;
    for (const ex of t.exercises || []) {
      if (ex.accessoryMode === undefined) { ex.accessoryMode = false; changed = true; }
    }
    if (changed) ctx.write('templates', t);
  }
}

/**
 * v8 — Retires the binary Practice toggle in favor of a per-exercise
 * customRPE override: a plain number the person sets directly, rather
 * than a fixed 6/7 cap. Exercises that had practiceMode: true convert to
 * an explicit customRPE at whatever value Practice used to cap them to —
 * 6 for a lift tiering as compound, 7 for isolation, using the same
 * compound/isolation tiering Accessory mode already overrides (see
 * effectiveCompoundForTiering() in autoreg-math.js) — so an existing
 * program keeps behaving the same the moment this ships rather than
 * silently reverting to full phase-driven RPE. Exercises that never used
 * Practice get customRPE: null (no override; phase default applies, same
 * as always).
 *
 * The old practiceMode field is left in place rather than deleted — it's
 * simply never read again anywhere in the app going forward. Deleting it
 * would make this migration's completion look identical to v5 never
 * having run (both would show "no practiceMode field"), which would fool
 * v5's OWN self-guard into re-firing on a from-scratch re-run and
 * re-deriving customRPE from a phantom practiceMode. A harmless, unread
 * boolean left behind is simpler and safer than untangling that.
 */
function migratePracticeToCustomRPE(ctx) {
  const liftById = {};
  for (const l of ctx.lifts) liftById[l.id] = l;

  for (const t of ctx.templates) {
    let changed = false;
    for (const ex of t.exercises || []) {
      if (ex.customRPE !== undefined) continue; // self-guard
      if (ex.practiceMode === true) {
        const lift = liftById[ex.liftId];
        const tieringCompound = !!(lift && lift.isCompound) && !ex.accessoryMode;
        ex.customRPE = tieringCompound ? 6 : 7; // old PRACTICE_RPE_CAP_COMPOUND / PRACTICE_RPE_CAP_ISOLATION
      } else {
        ex.customRPE = null;
      }
      changed = true;
    }
    if (changed) ctx.write('templates', t);
  }
}

/**
 * v9 — Moves Assisted from a per-exercise toggle (settable per template,
 * or mid-workout) to a fixed property of the LIFT itself, set once in
 * Edit Lift. Backfills isAssisted: false on every lift, EXCEPT a lift
 * that was already being used with assistedMode: true on some existing
 * template OR session exercise (an ad-hoc exercise added mid-workout and
 * toggled Assisted there never touches a template, so both sources need
 * checking) — that lift gets isAssisted: true instead, so a program that
 * was already treating a lift as assisted keeps behaving the same the
 * moment this ships, rather than silently losing the assistance-unit
 * conversion the next time it's used.
 *
 * The old per-exercise assistedMode field is left in place on templates
 * and sessions (same reasoning as v8's practiceMode) — it's simply never
 * read again; the lift's own isAssisted is now the only source of truth.
 */
function migrateAssistedToLift(ctx) {
  const assistedLiftIds = new Set();
  for (const t of ctx.templates) {
    for (const ex of t.exercises || []) {
      if (ex.assistedMode === true) assistedLiftIds.add(ex.liftId);
    }
  }
  for (const s of ctx.sessions) {
    for (const ex of s.exercises || []) {
      if (ex.assistedMode === true) assistedLiftIds.add(ex.liftId);
    }
  }

  for (const lift of ctx.lifts) {
    if (lift.isAssisted !== undefined) continue; // self-guard
    lift.isAssisted = assistedLiftIds.has(lift.id);
    ctx.write('lifts', lift);
  }
}

/**
 * v10 — AutoReg simplified: the template-folder system (folders, per-folder
 * day slots, active-folder switching) collapses into ONE weekly plan —
 * settings.weeklyPlan, a plain { dow: templateId | null } map for weekdays
 * 0–6 (Sunday-indexed, same as the old folder day slots). Seeded from the
 * ACTIVE folder's slots so whatever schedule was driving "Today's Session"
 * keeps driving it, unchanged, on first boot of the simplified app.
 * Folders, their metadata, and every template are left in place untouched
 * (non-destructive: templates are still the unit the plan points at; the
 * folder records are simply never read again).
 */
function migrateWeeklyPlan(ctx) {
  if (ctx.settings.weeklyPlan) return; // self-guard
  const folders = Array.isArray(ctx.settings.templateFolders) ? ctx.settings.templateFolders : [];
  const active = folders.find((f) => f.active) || null;
  const plan = {};
  for (let d = 0; d <= 6; d++) plan[d] = (active && active.days && active.days[d]) || null;
  ctx.settings.weeklyPlan = plan;
  ctx.touchSettings();
}

/**
 * v11 — Load jumps become lift-aware. The single flat settings.minIncrement
 * (one rounding step for every lift) splits into settings.compoundIncrement
 * and settings.isolationIncrement, plus an optional per-lift loadIncrement
 * override (added directly on lift records as they're edited — nothing to
 * backfill there). Both new settings seed from the OLD flat value so an
 * existing install's prescriptions are numerically IDENTICAL the moment
 * this ships; the split only starts to matter once the person opens
 * Settings or a lift's Edit form and gives one category (or one lift) a
 * different number than the other.
 */
function migrateLoadIncrementSplit(ctx) {
  if (ctx.settings.minIncrement == null) return; // fresh install already has the new fields; nothing to carry forward
  if (ctx.settings.compoundIncrement != null) return; // self-guard
  ctx.settings.compoundIncrement = ctx.settings.minIncrement;
  ctx.settings.isolationIncrement = ctx.settings.minIncrement;
  delete ctx.settings.minIncrement;
  ctx.touchSettings();
}

// The ordered registry. Append-only; never renumber existing entries.
const MIGRATIONS = [
  { version: 1, name: 'liftGroups', migrate: migrateLiftGroups },
  { version: 2, name: 'liftCompound', migrate: migrateLiftCompound },
  { version: 3, name: 'templateFolders', migrate: migrateTemplateFolders },
  { version: 4, name: 'templateAutoRPE', migrate: migrateTemplateAutoRPE },
  { version: 5, name: 'practiceMode', migrate: migratePracticeMode },
  { version: 6, name: 'assistedMode', migrate: migrateAssistedMode },
  { version: 7, name: 'accessoryMode', migrate: migrateAccessoryMode },
  { version: 8, name: 'practiceToCustomRPE', migrate: migratePracticeToCustomRPE },
  { version: 9, name: 'assistedToLift', migrate: migrateAssistedToLift },
  { version: 10, name: 'weeklyPlan', migrate: migrateWeeklyPlan },
  { version: 11, name: 'loadIncrementSplit', migrate: migrateLoadIncrementSplit },
];

const LATEST_DATA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** Pure selector: migrations still needing to run for `currentVersion`, ascending. */
function pendingMigrations(currentVersion, migrations) {
  const list = migrations || MIGRATIONS;
  return list
    .filter((m) => m.version > (currentVersion || 0))
    .slice()
    .sort((a, b) => a.version - b.version);
}

/**
 * Run ONE migration against an in-memory snapshot and return what it queued.
 * Pure — no persistence. The runner calls this per pending migration, then
 * flushes `writes`, persists settings if `settingsDirty`, and commits the
 * version — in that order — so a crash between steps re-runs only the
 * interrupted (idempotent) step.
 */
function runMigrationStep(migration, snapshot, deps) {
  const writes = [];
  let settingsDirty = false;
  const ctx = {
    lifts: snapshot.lifts || [],
    sessions: snapshot.sessions || [],
    templates: snapshot.templates || [],
    checkins: snapshot.checkins || [],
    symptoms: snapshot.symptoms || [],
    settings: snapshot.settings || {},
    deps: deps || {},
    write(store, record) { writes.push({ store, record }); },
    touchSettings() { settingsDirty = true; },
  };
  migration.migrate(ctx);
  return { writes, settingsDirty, ctx };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MIGRATIONS, LATEST_DATA_VERSION, pendingMigrations, runMigrationStep,
    migrateLiftGroups, migrateLiftCompound, migrateTemplateFolders, migrateTemplateAutoRPE, migratePracticeMode, migrateAssistedMode, migrateAccessoryMode, migratePracticeToCustomRPE, migrateAssistedToLift, migrateWeeklyPlan, migrateLoadIncrementSplit,
  };
}
