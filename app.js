'use strict';

/* ============================================================
   AUTOREG — Simplified
   One idea: the engine owns the plan — load, sets, warm-ups, rest,
   deloads — and the only required input is actual vs planned reps/effort.

   Three screens (Today / Plan / History) + a settings sheet. All pure
   autoregulation math lives in autoreg-math.js (unit-tested, unchanged);
   all data-shape migrations live in autoreg-migrations.js. This file is
   the data layer, the block-periodization clock, and the UI.

   Data compatibility is a hard constraint: same IndexedDB (autoreg-db),
   same stores/keyPaths, same session/template/lift/settings record
   shapes as the full app — existing training history loads as-is, and
   migration v10 folds the old template-folder schedule into the single
   weekly plan.
   ============================================================ */

/* ---------------- IndexedDB data layer (unchanged schema) ---------------- */
const DB_NAME = 'autoreg-db';
const DB_VERSION = 1;

let dbInstance = null;
function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('lifts')) db.createObjectStore('lifts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('templates')) db.createObjectStore('templates', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('checkins')) db.createObjectStore('checkins', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('symptoms')) db.createObjectStore('symptoms', { keyPath: 'id' });
    };
    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- Utilities ---------------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(msg, opts) {
  const host = document.getElementById('toast-host');
  const t = document.createElement('div');
  t.className = 'toast';
  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-msg';
  msgSpan.textContent = msg;
  t.appendChild(msgSpan);
  const dismissTimer = setTimeout(() => t.remove(), (opts && opts.duration) || 2400);
  if (opts && opts.actionLabel && typeof opts.onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => { clearTimeout(dismissTimer); t.remove(); opts.onAction(); });
    t.appendChild(btn);
  }
  host.appendChild(t);
}

/** One shared modal. openModal({ title, body, onOpen }) — body is HTML;
 *  onOpen(root) wires it. Backdrop tap or the × closes. */
function openModal(cfg) {
  const host = document.getElementById('modal-host');
  host.innerHTML = `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal" role="dialog" aria-label="${escapeHTML(cfg.title)}">
        <div class="modal-head">
          <span class="modal-title">${escapeHTML(cfg.title)}</span>
          <button class="icon-btn" data-modal-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="modal-body">${cfg.body}</div>
      </div>
    </div>`;
  const backdrop = host.firstElementChild;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) return closeModal(); // tap outside the sheet
    const btn = e.target.closest('[data-modal-close]');
    if (btn && btn !== backdrop) closeModal(); // explicit close/cancel buttons only
  });
  if (cfg.onOpen) cfg.onOpen(backdrop.querySelector('.modal'));
}
function closeModal() { document.getElementById('modal-host').innerHTML = ''; }

function confirmModal(title, bodyText, confirmLabel, onConfirm, danger) {
  openModal({
    title,
    body: `
      <p class="text-sm text-muted">${escapeHTML(bodyText)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Keep</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-go">${escapeHTML(confirmLabel)}</button>
      </div>`,
    onOpen: (root) => root.querySelector('#confirm-go').addEventListener('click', () => { closeModal(); onConfirm(); }),
  });
}

/* ---------------- Default lifts (seeded on first run) ----------------
   Trimmed to the powerlifting-relevant set. Names match the full app's
   presets exactly, so existing installs never get near-duplicates and
   round-tripping back to the full app stays clean. `groups` is kept as a
   field for record-shape compatibility but is no longer read. */
const DEFAULT_LIFTS = [
  { name: 'Back Squat', isCompound: true }, { name: 'Front Squat', isCompound: true },
  { name: 'Leg Press', isCompound: true }, { name: 'Bulgarian Split Squat', isCompound: true },
  { name: 'Leg Curl', isCompound: false }, { name: 'Leg Extension', isCompound: false },
  { name: 'Deadlift', isCompound: true }, { name: 'Sumo Deadlift', isCompound: true },
  { name: 'Romanian Deadlift', isCompound: true }, { name: 'Good Morning', isCompound: true },
  { name: 'Rack Pull', isCompound: true }, { name: 'Hip Thrust', isCompound: true },
  { name: 'Bench Press', isCompound: true }, { name: 'Close-Grip Bench Press', isCompound: true },
  { name: 'Incline Bench Press', isCompound: true }, { name: 'Dumbbell Bench Press', isCompound: true },
  { name: 'Incline Dumbbell Press', isCompound: true }, { name: 'Dip', isCompound: true },
  { name: 'Overhead Press', isCompound: true }, { name: 'Push Press', isCompound: true },
  { name: 'Barbell Row', isCompound: true }, { name: 'Pendlay Row', isCompound: true },
  { name: 'Pull-Up', isCompound: true }, { name: 'Chin-Up', isCompound: true },
  { name: 'Lat Pulldown', isCompound: true }, { name: 'Face Pull', isCompound: false },
  { name: 'Triceps Pushdown', isCompound: false }, { name: 'Lateral Raise', isCompound: false },
  { name: 'Shrug', isCompound: false }, { name: 'Hanging Leg Raise', isCompound: false },
  { name: 'Plank', isCompound: false },
].map((l) => ({ ...l, groups: [] }));

// Migration v1 dependency, unchanged — see autoreg-migrations.js.
const LEGACY_GROUP_FALLBACK = {
  Squat: [{ group: 'Quads', role: 'primary' }, { group: 'Glutes', role: 'secondary' }],
  Bench: [{ group: 'Chest', role: 'primary' }, { group: 'Triceps', role: 'secondary' }, { group: 'Shoulders', role: 'secondary' }],
  Deadlift: [{ group: 'Hamstrings', role: 'primary' }, { group: 'Glutes', role: 'primary' }, { group: 'Lats', role: 'secondary' }],
  Back: [{ group: 'Lats', role: 'primary' }],
  Shoulders: [{ group: 'Shoulders', role: 'primary' }],
  Arms: [{ group: 'Biceps', role: 'primary' }, { group: 'Triceps', role: 'primary' }],
  'Legs (accessory)': [{ group: 'Quads', role: 'primary' }],
  Core: [{ group: 'Core', role: 'primary' }],
  Grip: [{ group: 'Forearms', role: 'primary' }],
};

const PRESET_TEMPLATES = [
  { name: 'SBD — Squat Day', exercises: [
    { liftName: 'Back Squat', targetSets: 4, targetRepsLow: 3, targetRepsHigh: 5, warmupEnabled: true },
    { liftName: 'Romanian Deadlift', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, warmupEnabled: false },
    { liftName: 'Leg Press', targetSets: 3, targetRepsLow: 10, targetRepsHigh: 12, warmupEnabled: false },
    { liftName: 'Hanging Leg Raise', targetSets: 3, targetRepsLow: 10, targetRepsHigh: 15, warmupEnabled: false },
  ] },
  { name: 'SBD — Bench Day', exercises: [
    { liftName: 'Bench Press', targetSets: 4, targetRepsLow: 3, targetRepsHigh: 5, warmupEnabled: true },
    { liftName: 'Barbell Row', targetSets: 4, targetRepsLow: 6, targetRepsHigh: 8, warmupEnabled: false },
    { liftName: 'Overhead Press', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, warmupEnabled: false },
    { liftName: 'Triceps Pushdown', targetSets: 3, targetRepsLow: 10, targetRepsHigh: 12, warmupEnabled: false },
  ] },
  { name: 'SBD — Deadlift Day', exercises: [
    { liftName: 'Deadlift', targetSets: 3, targetRepsLow: 2, targetRepsHigh: 3, warmupEnabled: true },
    { liftName: 'Front Squat', targetSets: 3, targetRepsLow: 5, targetRepsHigh: 5, warmupEnabled: false },
    { liftName: 'Barbell Row', targetSets: 3, targetRepsLow: 8, targetRepsHigh: 10, warmupEnabled: false },
    { liftName: 'Plank', targetSets: 3, targetRepsLow: 1, targetRepsHigh: 1, warmupEnabled: false },
  ] },
];

/* ---------------- App State ---------------- */
const State = {
  lifts: [],
  sessions: [],
  templates: [],
  checkins: [],
  symptoms: [], // read-only legacy store — kept loaded so backups stay complete
  settings: { age: null, gender: '', heightIn: null, weightLb: null, compoundIncrement: 5, isolationIncrement: 2.5, units: 'lb' },
  activeWorkout: null,
  currentTab: 'today',
};

async function saveSettings() {
  await dbPut('settings', { key: 'profile', value: { ...State.settings } });
}

async function loadAllState() {
  const [lifts, sessions, templates, checkins, symptoms, settingsRows] = await Promise.all([
    dbGetAll('lifts'), dbGetAll('sessions'), dbGetAll('templates'),
    dbGetAll('checkins'), dbGetAll('symptoms'), dbGetAll('settings'),
  ]);
  State.lifts = lifts;
  State.sessions = sessions.sort((a, b) => b.date.localeCompare(a.date));
  State.templates = templates;
  State.checkins = checkins.sort((a, b) => b.date.localeCompare(a.date));
  State.symptoms = symptoms;

  const settingsMap = {};
  settingsRows.forEach((r) => { settingsMap[r.key] = r.value; });
  Object.assign(State.settings, settingsMap.profile || {});

  await runMigrations();
  await seedMissingDefaultLifts();
  await seedPresetTemplates();
}

/* ---------------- Versioned migration runner (unchanged mechanism) ---------------- */
async function getDataVersion() {
  const row = await dbGet('settings', 'meta');
  return (row && row.value && row.value.userDataVersion) || 0;
}

async function setDataVersion(version) {
  const existing = (await dbGet('settings', 'meta')) || { key: 'meta', value: {} };
  const value = { ...(existing.value || {}), userDataVersion: version };
  await dbPut('settings', { key: 'meta', value });
}

async function runMigrations() {
  const current = await getDataVersion();
  const pending = pendingMigrations(current, MIGRATIONS);
  if (pending.length === 0) return;
  const deps = { DEFAULT_LIFTS, LEGACY_GROUP_FALLBACK, uid };
  const snapshot = {
    lifts: State.lifts, sessions: State.sessions, templates: State.templates,
    checkins: State.checkins, symptoms: State.symptoms, settings: State.settings,
  };
  for (const migration of pending) {
    const { writes, settingsDirty } = runMigrationStep(migration, snapshot, deps);
    for (const w of writes) await dbPut(w.store, w.record);
    if (settingsDirty) await saveSettings();
    await setDataVersion(migration.version);
    console.info(`AutoReg data migration v${migration.version} (${migration.name}) applied.`);
  }
}

/* ---------------- Idempotent seeders ---------------- */
async function seedMissingDefaultLifts() {
  const existingNames = new Set(State.lifts.map((l) => l.name));
  for (const l of DEFAULT_LIFTS) {
    if (existingNames.has(l.name)) continue;
    const lift = { id: uid(), name: l.name, groups: [], isCompound: l.isCompound, isAssisted: false, custom: false, createdAt: todayISO() };
    await dbPut('lifts', lift);
    State.lifts.push(lift);
  }
}

async function seedPresetTemplates() {
  if (State.templates.length > 0) return; // any existing template = never seed
  for (const pt of PRESET_TEMPLATES) {
    const exercises = pt.exercises
      .map((e) => {
        const lift = State.lifts.find((l) => l.name === e.liftName);
        return lift ? { liftId: lift.id, targetSets: e.targetSets, targetRepsLow: e.targetRepsLow, targetRepsHigh: e.targetRepsHigh, warmupEnabled: e.warmupEnabled } : null;
      })
      .filter(Boolean);
    if (exercises.length === 0) continue;
    const template = { id: uid(), name: pt.name, exercises, preset: true, createdAt: todayISO() };
    await dbPut('templates', template);
    State.templates.push(template);
  }
}

/* ---------------- Lift helpers ---------------- */
function getLift(id) { return State.lifts.find((l) => l.id === id); }
function getLiftIsCompound(lift) { return !!(lift && lift.isCompound); }
function getLiftIsAssisted(lift) { return !!(lift && lift.isAssisted); }

/**
 * The rounding/step size used everywhere a weight is prescribed for THIS
 * lift — how big a "jump" the app will suggest. This is the mechanism
 * that makes autoregulation lift-aware: a barbell compound like Squat
 * moves in whole plates, so an easy set jumps by a few pounds; a small
 * cable/machine/grip lift (e.g. a gripper) is adjustable far more finely,
 * so the same "easy" RPE gap should move it by a much smaller amount —
 * otherwise the exact same 2-RPE-under-target signal produces a
 * proportionally enormous swing on the small lift and a negligible one on
 * the big one.
 *
 * Two knobs, in priority order:
 *   1. lift.loadIncrement — an explicit per-lift override (set via New/
 *      Edit Lift), for anything that doesn't fit its category default —
 *      a specific gripper model, a machine with unusually coarse pins.
 *   2. Category default — settings.compoundIncrement / .isolationIncrement,
 *      keyed off the lift's isCompound flag. Compounds default coarser
 *      (whole-plate barbell math); isolation/accessory/grip work defaults
 *      finer, since that's usually true of the equipment AND the stakes
 *      of a mis-sized jump are lower on an accessory lift than a squat.
 * Never returns non-positive — a corrupted/zero setting falls back to a
 * safe default rather than letting rounding math divide by zero.
 */
function getLiftIncrement(lift) {
  if (lift && lift.loadIncrement != null && lift.loadIncrement > 0) return lift.loadIncrement;
  const isCompound = getLiftIsCompound(lift);
  const fallback = isCompound ? 5 : 2.5;
  const configured = isCompound ? State.settings.compoundIncrement : State.settings.isolationIncrement;
  return (configured != null && configured > 0) ? configured : fallback;
}

/* ---------------- Template exercise defaults ---------------- */

// Lift NAMES treated as a program's "main lift" — trained for low reps
// and more sets rather than accessory volume. A short, explicit list
// rather than an inferred property, since nothing on a lift record says
// "how central is this to the program" beyond its name. Anything not
// listed falls back to the compound/isolation split below — including
// every custom lift, which can't be classified any more finely than that.
const PRIMARY_LIFT_NAMES = new Set([
  'Back Squat', 'Front Squat', 'Bench Press', 'Close-Grip Bench Press',
  'Incline Bench Press', 'Overhead Press', 'Deadlift', 'Sumo Deadlift',
]);
// Deadlift variants specifically run lower reps than the rest of the
// primary list — same near-max loading, much higher per-rep fatigue cost.
const PRIMARY_PULL_LIFT_NAMES = new Set(['Deadlift', 'Sumo Deadlift']);

/**
 * Sensible starting sets/reps for a lift just added to a template, so most
 * exercises need zero editing afterward — only genuine exceptions (holds,
 * unusual accessory work) need the manual tweak the edit fields are there
 * for. Same idea as every other autofill in the app: get the common case
 * right, leave the door open for everything else.
 *   Primary pull (deadlift family — highest fatigue cost)  — 3×2–3
 *   Primary lift (squat/bench/press family)                — 4×3–5
 *   Other compound (secondary/assistance movements)         — 3×6–8
 *   Isolation/accessory                                     — 3×10–12
 * Warm-up defaults on for anything compound, off for isolation — the same
 * rule used everywhere else a warm-up ramp gets attached.
 */
function defaultTemplateExercise(liftId) {
  const lift = getLift(liftId);
  const name = lift ? lift.name : '';
  const isCompound = getLiftIsCompound(lift);
  let targetSets, targetRepsLow, targetRepsHigh;
  if (PRIMARY_PULL_LIFT_NAMES.has(name)) { targetSets = 3; targetRepsLow = 2; targetRepsHigh = 3; }
  else if (PRIMARY_LIFT_NAMES.has(name)) { targetSets = 4; targetRepsLow = 3; targetRepsHigh = 5; }
  else if (isCompound) { targetSets = 3; targetRepsLow = 6; targetRepsHigh = 8; }
  else { targetSets = 3; targetRepsLow = 10; targetRepsHigh = 12; }
  return { liftId, targetSets, targetRepsLow, targetRepsHigh, warmupEnabled: isCompound };
}

function getLiftSessionSets(liftId) {
  const out = [];
  for (const s of State.sessions) {
    for (const ex of s.exercises || []) {
      if (ex.liftId !== liftId) continue;
      for (const set of ex.sets || []) {
        if (set.weight != null && set.reps != null && set.completed && !set.isWarmup) {
          out.push({ date: s.date, weight: set.weight, reps: set.reps, rpe: set.rpe });
        }
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function effectiveLoadForHistoricalSet(set, isAssisted) {
  if (!isAssisted) return set.weight;
  const bodyweight = State.settings.weightLb;
  if (bodyweight == null) return null;
  return assistedEffectiveLoad(bodyweight, set.weight);
}

function getLiftCurrentE1RM(liftId) {
  const isAssisted = getLiftIsAssisted(getLift(liftId));
  const sets = getLiftSessionSets(liftId);
  let e1rm = 0;
  for (const s of sets) {
    const effLoad = effectiveLoadForHistoricalSet(s, isAssisted);
    if (effLoad == null) continue;
    const val = e1RMFromSet(effLoad, s.reps, s.rpe || 8);
    e1rm = rollForwardE1RM(e1rm, val);
  }
  return Math.round(e1rm);
}

/* ---------------- Block periodization clock ---------------- */
const PHASE_KEYS = ['Accumulation', 'Intensification', 'Max', 'Deload'];
const DEFAULT_CYCLE_WEEKS = 9;
const AUTO_SCHEDULE_RATIO = { Accumulation: 3, Intensification: 3, Max: 2, Deload: 1 };

function computeAutoSchedule(totalWeeks) {
  const n = Math.max(1, Math.round(totalWeeks) || DEFAULT_CYCLE_WEEKS);
  const ratioSum = Object.values(AUTO_SCHEDULE_RATIO).reduce((a, b) => a + b, 0);
  const raw = PHASE_KEYS.map((p) => (n * AUTO_SCHEDULE_RATIO[p]) / ratioSum);
  const alloc = raw.map((v) => Math.floor(v));
  let remainder = n - alloc.reduce((a, b) => a + b, 0);
  const fracOrder = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  let idx = 0;
  while (remainder > 0) { alloc[fracOrder[idx % fracOrder.length].i] += 1; remainder--; idx++; }
  const deloadIdx = PHASE_KEYS.indexOf('Deload');
  if (n >= 4 && alloc[deloadIdx] < 1) {
    const maxIdx = alloc.indexOf(Math.max(...alloc));
    if (alloc[maxIdx] > 1) { alloc[maxIdx]--; alloc[deloadIdx]++; }
  }
  const schedule = [];
  PHASE_KEYS.forEach((p, i) => { for (let w = 0; w < alloc[i]; w++) schedule.push(p); });
  while (schedule.length < n) schedule.push('Deload');
  while (schedule.length > n) schedule.pop();
  return schedule;
}

/** Simplified plan: cycle length + week anchor only; the schedule is
 *  always auto-distributed. Old custom-phase plans fall back to auto with
 *  the same length — the anchor (which week you're on) is preserved. */
function getBlockPlan() {
  const plan = State.settings.blockPlan || {};
  const weeks = clamp(parseInt(plan.weeks, 10) || DEFAULT_CYCLE_WEEKS, 1, 20);
  const anchorWeek = clamp(parseInt(plan.anchorWeek, 10) || 1, 1, weeks);
  return { weeks, anchorWeek, anchorDate: plan.anchorDate || null };
}

function getCurrentBlock() {
  const plan = getBlockPlan();
  const schedule = computeAutoSchedule(plan.weeks);
  const n = schedule.length;
  const anchorDateStr = plan.anchorDate || (State.sessions.length > 0 ? State.sessions[State.sessions.length - 1].date : todayISO());
  const anchorWeek = plan.anchorDate ? plan.anchorWeek : 1;
  const anchorDate = new Date(anchorDateStr + 'T00:00:00');
  const today = new Date(todayISO() + 'T00:00:00');
  const weeksSinceAnchor = Math.floor((today - anchorDate) / (7 * 86400000));
  const weekInCycle = (((anchorWeek - 1 + weeksSinceAnchor) % n) + n) % n + 1;
  const phase = schedule[weekInCycle - 1];
  return { phase, weekInCycle, cycleLength: n, schedule };
}

function getPhaseTrainingRPE(isCompound) {
  return phaseTrainingRPE(getCurrentBlock().phase, isCompound);
}

/* ---------------- Daily readiness ---------------- */
const READINESS_CHOICES = [
  { label: 'Rough', feeling: 2 }, { label: 'Low', feeling: 4 }, { label: 'OK', feeling: 6 },
  { label: 'Good', feeling: 8 }, { label: 'Great', feeling: 10 },
];

function getTodayCheckin() { return State.checkins.find((c) => c.date === todayISO()); }

async function setTodayReadiness(feeling) {
  const existing = getTodayCheckin();
  const row = existing ? { ...existing, feeling } : { date: todayISO(), feeling };
  await dbPut('checkins', row);
  const idx = State.checkins.findIndex((c) => c.date === row.date);
  if (idx >= 0) State.checkins[idx] = row; else State.checkins.unshift(row);
}

/** One number for the day. Old check-ins may also carry sleep/stress —
 *  if present they still vote (readinessLoadMultiplier is null-tolerant),
 *  so history recorded by the full app keeps its meaning. */
function getSessionReadiness() {
  const c = getTodayCheckin() || {};
  const multiplier = readinessLoadMultiplier(c.sleep ?? null, c.stress ?? null, c.feeling ?? null, 'unknown');
  const pct = Math.round((multiplier - 1) * 100);
  const label = pct === 0 ? 'neutral' : `${pct > 0 ? '+' : ''}${pct}% load`;
  return { multiplier, pct, label };
}

function sessionReadiness() {
  if (State.activeWorkout && State.activeWorkout.readiness) return State.activeWorkout.readiness;
  return getSessionReadiness();
}

function applyReadinessEffective(effectiveWeight, increment) {
  if (effectiveWeight == null) return null;
  const m = sessionReadiness().multiplier;
  if (m === 1) return effectiveWeight;
  return Math.max(increment, roundToIncrement(effectiveWeight * m, increment));
}

/* ---------------- Weekly plan ---------------- */
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getWeeklyPlan() {
  const p = State.settings.weeklyPlan || {};
  const out = {};
  for (let d = 0; d <= 6; d++) out[d] = p[d] || null;
  return out;
}

async function setPlanDay(dow, templateId) {
  const p = getWeeklyPlan();
  p[dow] = templateId;
  State.settings.weeklyPlan = p;
  await saveSettings();
}

function getTemplateById(id) { return State.templates.find((t) => t.id === id) || null; }
function getTemplateForToday() {
  const id = getWeeklyPlan()[new Date().getDay()];
  return id ? getTemplateById(id) : null;
}

/* ============================================================
   SESSION ENGINE
   (same math and behavior as the full app; drop sets and manual
   set-type cycling removed — the engine manages set count itself)
   ============================================================ */

function displayWeightForEffectiveLoad(ex, effectiveLoad, bodyweight, increment) {
  if (effectiveLoad == null) return null;
  if (!ex.isAssisted) return effectiveLoad;
  if (bodyweight == null) return null;
  return assistedDialIn(bodyweight, effectiveLoad, increment);
}

function effectiveLoadForDisplayWeight(ex, displayWeight, bodyweight) {
  if (displayWeight == null) return null;
  if (!ex.isAssisted) return displayWeight;
  if (bodyweight == null) return null;
  return assistedEffectiveLoad(bodyweight, displayWeight);
}

function recomputeExerciseTargets(ex) {
  const increment = getLiftIncrement(getLift(ex.liftId));
  const bodyweight = State.settings.weightLb || null;
  // Default target intensity is driven by the current block phase
  // (compound/isolation split, see phaseTrainingRPE). A session-level
  // override — set via the "Target Intensity" control on the active
  // workout — replaces that default with ONE RPE for every exercise in
  // the workout, for the rest of that session only; it lives on
  // State.activeWorkout, so a new session always reverts to the block
  // default. See applyIntensityOverride()/clearIntensityOverride().
  const override = State.activeWorkout && State.activeWorkout.rpeOverride != null ? State.activeWorkout.rpeOverride : null;
  ex.targetRPE = override != null ? override : getPhaseTrainingRPE(ex.isCompound);
  const e1rm = getLiftCurrentE1RM(ex.liftId);
  const projectedTopEffective = (e1rm && ex.targetRepsLow != null)
    ? applyReadinessEffective(prescribeWeight(e1rm, ex.targetRepsLow, ex.targetRPE, increment), increment)
    : null;
  ex.hasE1RM = !!e1rm;
  ex.hasBodyweight = bodyweight != null;
  ex.projectedTopWeight = displayWeightForEffectiveLoad(ex, projectedTopEffective, bodyweight, increment);
  ex.sets.forEach((set) => {
    if (set.isWarmup && !set.completed && set.warmupPct != null) {
      const effWeight = projectedTopEffective != null ? roundToIncrement(projectedTopEffective * (set.warmupPct / 100), increment) : null;
      set.weight = displayWeightForEffectiveLoad(ex, effWeight, bodyweight, increment);
    }
  });
  return projectedTopEffective;
}

function buildActiveExercise(liftId, targetSets, targetRepsLow, targetRepsHigh, warmupEnabled) {
  const lift = getLift(liftId);
  const ex = {
    liftId,
    targetRepsLow: targetRepsLow ?? null,
    targetRepsHigh: targetRepsHigh || targetRepsLow || null,
    warmupEnabled: !!warmupEnabled,
    isAssisted: getLiftIsAssisted(lift),
    isCompound: getLiftIsCompound(lift),
    sets: [],
  };
  const increment = getLiftIncrement(lift);
  const bodyweight = State.settings.weightLb || null;
  const projectedTopEffective = recomputeExerciseTargets(ex);
  const warmupSets = warmupEnabled
    ? buildWarmupRamp(projectedTopEffective, increment).map((r) => ({
        weight: displayWeightForEffectiveLoad(ex, r.weight, bodyweight, increment),
        reps: r.reps, rpe: null, completed: false, isWarmup: true, warmupPct: r.pct,
      }))
    : [];
  const workingSets = Array.from({ length: targetSets }, () => ({ weight: null, reps: null, rpe: null, completed: false, isWarmup: false }));
  ex.sets = [...warmupSets, ...workingSets];
  return ex;
}

/** Most recent completed working set (weight+reps+rpe) is the basis; the
 *  next set is re-prescribed from ITS implied e1RM, with missed-rep safety
 *  layered on. Same recency logic as the full app, minus drop sets. */
function getSetSuggestion(ex, setIdx) {
  const targetSet = ex.sets[setIdx];
  const increment = getLiftIncrement(getLift(ex.liftId));
  const bodyweight = State.settings.weightLb || null;
  let basis = null;
  for (let i = setIdx - 1; i >= 0; i--) {
    const s = ex.sets[i];
    if (s.isWarmup) continue;
    if (s.weight == null || s.reps == null || s.rpe == null) continue;
    basis = s;
    break;
  }
  if (!basis) return null;
  const basisEffLoad = effectiveLoadForDisplayWeight(ex, basis.weight, bodyweight);
  if (basisEffLoad == null) return null;
  const basisE1RM = e1RMFromSet(basisEffLoad, basis.reps, basis.rpe);
  const repsForWeight = (targetSet && targetSet.reps != null) ? targetSet.reps : ex.targetRepsLow;
  let effectiveWeight = prescribeWeight(basisE1RM, repsForWeight, ex.targetRPE, increment);
  effectiveWeight = applyMissedRepSafety(effectiveWeight, ex.targetRepsLow, basis.reps, increment);
  const weight = displayWeightForEffectiveLoad(ex, effectiveWeight, bodyweight, increment);
  if (weight == null) return null;
  return { weight, reps: ex.targetRepsLow };
}

function autofillForSet(ex, setIdx) {
  const set = ex.sets[setIdx];
  if (set.isWarmup) return null;
  const suggestion = getSetSuggestion(ex, setIdx);
  if (suggestion) return { weight: suggestion.weight, reps: suggestion.reps, rpe: ex.targetRPE };
  const increment = getLiftIncrement(getLift(ex.liftId));
  const bodyweight = State.settings.weightLb || null;
  const e1rm = getLiftCurrentE1RM(ex.liftId);
  if (!e1rm || ex.targetRepsLow == null) return null;
  const effectiveWeight = applyReadinessEffective(prescribeWeight(e1rm, ex.targetRepsLow, ex.targetRPE, increment), increment);
  const weight = displayWeightForEffectiveLoad(ex, effectiveWeight, bodyweight, increment);
  if (weight == null) return null;
  return { weight, reps: ex.targetRepsLow, rpe: ex.targetRPE };
}

/**
 * In-session set-count autoregulation (see recommendSetDelta in
 * autoreg-math.js). Simplified app carries no per-muscle-group weekly
 * volume accounting, so the zone input is pinned to 'adaptive' — cuts
 * still fire on RPE overshoot / missed reps, adds still fire on an easy
 * final set, and the Deload/Max phase gate still applies. One adjustment
 * per exercise per session; always a toast with one-tap Undo.
 */
function autoregulateSetCount(exIdx, setIdx) {
  const ex = State.activeWorkout.exercises[exIdx];
  const set = ex.sets[setIdx];
  if (set.isWarmup || ex.autoSetAdjusted) return;
  if (set.rpe == null || ex.targetRPE == null || ex.targetRepsLow == null) return;

  const missedReps = Math.max(0, ex.targetRepsLow - (set.reps ?? ex.targetRepsLow));
  const delta = recommendSetDelta(set.rpe, ex.targetRPE, missedReps, 'adaptive', getCurrentBlock().phase);
  if (delta === 0) return;
  const lift = getLift(ex.liftId);
  const liftName = lift ? lift.name : 'exercise';

  if (delta === -1) {
    let cutIdx = -1;
    for (let i = ex.sets.length - 1; i >= 0; i--) {
      const s = ex.sets[i];
      if (i !== setIdx && !s.isWarmup && !s.completed) { cutIdx = i; break; }
    }
    if (cutIdx === -1) return;
    const removed = ex.sets.splice(cutIdx, 1)[0];
    ex.autoSetAdjusted = true;
    const reason = missedReps >= SET_CUT_MISSED_REPS ? 'reps came up short' : 'effort ran hot';
    showToast(`−1 set on ${liftName} — ${reason}`, {
      duration: 5000, actionLabel: 'Undo',
      onAction: () => {
        ex.sets.splice(Math.min(cutIdx, ex.sets.length), 0, removed);
        ex.autoSetAdjusted = false;
        refreshExerciseCard(exIdx);
      },
    });
    return;
  }

  const remaining = ex.sets.some((s) => !s.isWarmup && !s.completed);
  if (remaining) return;
  ex.sets.push({ weight: null, reps: null, rpe: null, completed: false, isWarmup: false });
  ex.autoSetAdjusted = true;
  showToast(`+1 set on ${liftName} — felt easy today`, {
    duration: 5000, actionLabel: 'Undo',
    onAction: () => {
      const last = ex.sets[ex.sets.length - 1];
      if (last && !last.completed && !last.isWarmup) ex.sets.pop();
      ex.autoSetAdjusted = false;
      refreshExerciseCard(exIdx);
    },
  });
}

/* ---------------- Rest timer ---------------- */
let restTimer = null; // { endsAt, total, interval }

function startRestTimer(rpe, isWarmup, reps) {
  dismissRestTimer();
  const seconds = restSecondsForRPE(rpe, isWarmup, reps);
  restTimer = { endsAt: Date.now() + seconds * 1000, total: seconds, interval: setInterval(renderRestTimer, 500) };
  renderRestTimer();
}

function renderRestTimer() {
  const host = document.getElementById('rest-timer-host');
  if (!restTimer) { host.innerHTML = ''; return; }
  const remaining = Math.max(0, Math.round((restTimer.endsAt - Date.now()) / 1000));
  if (remaining === 0) {
    dismissRestTimer();
    showToast('Rest done — next set');
    return;
  }
  const m = Math.floor(remaining / 60), s = remaining % 60;
  host.innerHTML = `
    <div class="rest-bar">
      <span class="rest-label">Rest</span>
      <span class="rest-clock">${m}:${String(s).padStart(2, '0')}</span>
      <div class="rest-track"><div class="rest-fill" style="width:${(remaining / restTimer.total) * 100}%"></div></div>
      <button class="btn-ghost text-sm" id="rest-skip">Skip</button>
    </div>`;
  host.querySelector('#rest-skip').addEventListener('click', dismissRestTimer);
}

function dismissRestTimer() {
  if (restTimer) clearInterval(restTimer.interval);
  restTimer = null;
  const host = document.getElementById('rest-timer-host');
  if (host) host.innerHTML = '';
}

/* ============================================================
   VIEWS
   ============================================================ */

function render() {
  const view = document.getElementById('view');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === State.currentTab));
  const block = getCurrentBlock();
  const pill = document.getElementById('phase-pill');
  pill.textContent = `${block.phase} · wk ${block.weekInCycle}/${block.cycleLength}`;
  pill.className = `phase-pill phase-${block.phase.toLowerCase()}`;

  if (State.currentTab === 'today') view.innerHTML = State.activeWorkout ? renderActiveWorkout() : renderTodayHome();
  else if (State.currentTab === 'plan') view.innerHTML = renderPlan();
  else view.innerHTML = renderHistory();

  wireView();
}

/* ---------------- Today (home) ---------------- */
function renderReadinessRow() {
  const c = getTodayCheckin();
  const r = getSessionReadiness();
  return `
    <div class="card readiness-card">
      <div class="flex-between">
        <span class="card-title mb-0">How ready are you?</span>
        ${c && c.feeling != null ? `<span class="readiness-effect ${r.pct < 0 ? 'down' : r.pct > 0 ? 'up' : ''}">${r.pct === 0 ? 'load as planned' : r.label}</span>` : ''}
      </div>
      <div class="readiness-chips">
        ${READINESS_CHOICES.map((ch) => `<button class="chip ${c && c.feeling === ch.feeling ? 'active' : ''}" data-readiness="${ch.feeling}">${ch.label}</button>`).join('')}
      </div>
    </div>`;
}

function renderTodayHome() {
  const tpl = getTemplateForToday();
  const others = State.templates;
  return `
    ${renderReadinessRow()}
    ${tpl ? `
      <div class="card session-card">
        <span class="eyebrow">Today · ${DOW[new Date().getDay()]}</span>
        <h2 class="session-title">${escapeHTML(tpl.name)}</h2>
        <div class="session-preview">
          ${(tpl.exercises || []).map((e) => {
            const lift = getLift(e.liftId);
            const ex = { liftId: e.liftId, isAssisted: getLiftIsAssisted(lift), isCompound: getLiftIsCompound(lift), targetRepsLow: e.targetRepsLow, sets: [] };
            recomputeExerciseTargets(ex);
            return `<div class="preview-row">
              <span>${lift ? escapeHTML(lift.name) : 'Unknown lift'}</span>
              <span class="mono">${e.targetSets}×${e.targetRepsLow}${e.targetRepsHigh !== e.targetRepsLow ? '–' + e.targetRepsHigh : ''}${ex.projectedTopWeight != null ? ` @ ${ex.projectedTopWeight}` : ''}</span>
            </div>`;
          }).join('')}
        </div>
        <button class="btn btn-primary btn-lg" data-start-template="${tpl.id}">Start Session</button>
      </div>
    ` : `
      <div class="card session-card">
        <span class="eyebrow">Today · ${DOW[new Date().getDay()]}</span>
        <h2 class="session-title">Rest day</h2>
        <p class="text-sm text-muted">Nothing scheduled. Recovery is programming too — or start any session below.</p>
      </div>
    `}
    ${others.length ? `
      <span class="section-label">${tpl ? 'Or start a different session' : 'Start a session'}</span>
      ${others.filter((t) => !tpl || t.id !== tpl.id).map((t) => `
        <button class="row-btn" data-start-template="${t.id}">
          <span>${escapeHTML(t.name)}</span>
          <span class="text-xs text-faint">${(t.exercises || []).length} lifts</span>
        </button>`).join('')}
    ` : ''}
    <button class="row-btn row-btn-ghost" id="btn-start-empty">Start an empty session</button>
  `;
}

/* ---------------- Active workout ---------------- */
function startWorkout(template) {
  const exercises = template
    ? template.exercises.map((ex) => buildActiveExercise(ex.liftId, ex.targetSets, ex.targetRepsLow, ex.targetRepsHigh, ex.warmupEnabled))
    : [];
  State.activeWorkout = {
    id: uid(),
    name: template ? template.name : 'Workout — ' + fmtDate(todayISO()),
    date: todayISO(),
    templateId: template ? template.id : null,
    readiness: getSessionReadiness(),
    rpeOverride: null, // null = block-phase default; see applyIntensityOverride()
    exercises,
  };
  render();
}

/**
 * Sets ONE target RPE for every exercise in the current workout, in place
 * of the block-phase default (which normally varies by compound vs.
 * isolation). Re-derives every exercise's projected top and not-yet-
 * completed warm-up weights against it immediately — already-logged sets
 * are never rewritten, only what's still ahead in the session.
 */
function applyIntensityOverride(value) {
  State.activeWorkout.rpeOverride = value;
  State.activeWorkout.exercises.forEach((ex) => recomputeExerciseTargets(ex));
}

/** Reverts the session to the block-phase default (the normal state for
 *  a workout that was never overridden). */
function clearIntensityOverride() {
  State.activeWorkout.rpeOverride = null;
  State.activeWorkout.exercises.forEach((ex) => recomputeExerciseTargets(ex));
}

let intensityDraft = null; // RPE being dialed in, live, before Save

function openIntensityModal() {
  const w = State.activeWorkout;
  intensityDraft = w.rpeOverride != null ? w.rpeOverride : getPhaseTrainingRPE(true);
  renderIntensityModal();
}

function renderIntensityModal() {
  const block = getCurrentBlock();
  const compoundDefault = getPhaseTrainingRPE(true);
  const isoDefault = getPhaseTrainingRPE(false);
  const isOverridden = State.activeWorkout.rpeOverride != null;
  openModal({
    title: 'Target Intensity',
    body: `
      <p class="text-sm text-muted">Defaults to this week's block phase — <strong>${block.phase}</strong> (RPE ${compoundDefault} compound · ${isoDefault} isolation). Setting a target here applies one RPE to every exercise for the rest of this workout.</p>
      <div class="intensity-stepper">
        <button class="icon-btn intensity-step" id="intensity-down" aria-label="Decrease target RPE">−</button>
        <span class="intensity-value mono">${intensityDraft.toFixed(1)}</span>
        <button class="icon-btn intensity-step" id="intensity-up" aria-label="Increase target RPE">+</button>
      </div>
      <div class="modal-actions">
        ${isOverridden ? '<button class="btn btn-ghost" id="intensity-reset">Use block default</button>' : ''}
        <button class="btn btn-primary" id="intensity-save">Set Target RPE</button>
      </div>`,
    onOpen: (root) => {
      root.querySelector('#intensity-down').addEventListener('click', () => { intensityDraft = clamp(intensityDraft - 0.5, 5, 10); renderIntensityModal(); });
      root.querySelector('#intensity-up').addEventListener('click', () => { intensityDraft = clamp(intensityDraft + 0.5, 5, 10); renderIntensityModal(); });
      root.querySelector('#intensity-save').addEventListener('click', () => {
        applyIntensityOverride(intensityDraft);
        closeModal();
        render();
        showToast(`Target RPE set to ${intensityDraft.toFixed(1)} for this workout`);
      });
      const resetBtn = root.querySelector('#intensity-reset');
      if (resetBtn) resetBtn.addEventListener('click', () => {
        clearIntensityOverride();
        closeModal();
        render();
        showToast('Target intensity reset to block default');
      });
    },
  });
}

function renderActiveWorkout() {
  const w = State.activeWorkout;
  const r = sessionReadiness();
  const intensityLabel = w.rpeOverride != null
    ? `Target RPE ${w.rpeOverride.toFixed(1)} · Custom`
    : `Target RPE ${getPhaseTrainingRPE(true)}–${getPhaseTrainingRPE(false)} · ${getCurrentBlock().phase} default`;
  return `
    <div class="flex-between" style="margin-bottom: var(--space-4)">
      <button class="btn-ghost text-sm" id="btn-cancel-workout">Cancel</button>
      <span class="text-sm text-muted">${escapeHTML(w.name)} — ${fmtDate(w.date)}</span>
    </div>
    <button class="intensity-chip ${w.rpeOverride != null ? 'custom' : ''}" id="btn-intensity">${intensityLabel}</button>
    ${r.pct !== 0 ? `<div class="readiness-banner ${r.pct < 0 ? 'down' : 'up'}">Readiness ${r.label} — prescriptions adjusted for today</div>` : ''}
    <div id="active-exercises">${w.exercises.map((ex, i) => `<div class="ex-wrap">${renderActiveExercise(ex, i)}</div>`).join('')}</div>
    <button class="btn btn-outline" id="btn-add-exercise">+ Add Exercise</button>
    <button class="btn btn-primary mt-4" id="btn-finish-workout">Finish Workout</button>
  `;
}

function renderActiveExercise(ex, exIdx) {
  const lift = getLift(ex.liftId);
  const e1rm = getLiftCurrentE1RM(ex.liftId);
  const jump = getLiftIncrement(lift);
  const targetText = ex.targetRepsLow != null
    ? `${ex.targetRepsLow}${ex.targetRepsHigh !== ex.targetRepsLow ? '–' + ex.targetRepsHigh : ''} reps @ RPE ${ex.targetRPE}`
    : `RPE ${ex.targetRPE} — log reps on any set to set the target`;
  return `
    <div class="exercise-card">
      <div class="exercise-card-head">
        <div>
          <div class="exercise-card-title">${lift ? escapeHTML(lift.name) : 'Unknown lift'}${ex.isAssisted ? ' <span class="assisted-badge">Assisted</span>' : ''}</div>
          <div class="exercise-card-meta mono">${targetText}${e1rm ? ` · e1RM ${e1rm}` : ' · first time — log by feel'} · jump ${jump}</div>
        </div>
        <button class="icon-btn" data-remove-ex="${exIdx}" aria-label="Remove exercise"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="set-labels"><span>#</span><span>${ex.isAssisted ? 'Assist' : 'Weight'}</span><span>Reps</span><span>Effort</span><span></span></div>
      ${ex.sets.map((set, setIdx) => renderSetRow(set, exIdx, setIdx, ex)).join('')}
      <button class="btn btn-ghost btn-sm" data-add-set="${exIdx}">+ Add Set</button>
    </div>`;
}

function effortTierAbbr(rpe) {
  const tier = EFFORT_TIERS.find((t) => t.id === rpeToEffortTier(rpe));
  return tier ? tier.abbr : '—';
}

/** Per-side plate hint for barbell compounds — shown inline under a
 *  working set's suggestion so there's nothing to open mid-session. */
function plateHint(weight) {
  if (weight == null || weight < 50) return '';
  const b = calculatePlateBreakdown(weight, 45);
  if (b.perSide.length === 0) return 'empty bar';
  const parts = b.perSide.map((p) => (p.count > 1 ? `${p.plate}×${p.count}` : `${p.plate}`)).join(' + ');
  return `${parts} /side${b.remainder ? ` (+${b.remainder})` : ''}`;
}

function renderSetRow(set, exIdx, setIdx, ex) {
  const suggestion = set.isWarmup ? null : getSetSuggestion(ex, setIdx);
  const fallbackWeight = (!set.isWarmup && ex.projectedTopWeight != null) ? ex.projectedTopWeight : null;
  const plannedWeight = suggestion ? suggestion.weight : fallbackWeight;
  const weightPlaceholder = set.isWarmup ? (ex.hasE1RM ? '' : 'feel')
    : (plannedWeight ?? (ex.isAssisted && !ex.hasBodyweight ? 'set BW' : (ex.hasE1RM ? 'lb' : '???')));
  const repsPlaceholder = ex.targetRepsLow ?? 'reps';
  const isNA = set.isWarmup;
  const effortAbbr = isNA ? 'N/A' : effortTierAbbr(set.rpe ?? ex.targetRPE);
  const showPlates = !set.isWarmup && !set.completed && ex.isCompound && !ex.isAssisted;
  const plateWeight = set.weight ?? plannedWeight;
  return `
    <div class="set-row ${set.completed ? 'completed' : ''} ${set.isWarmup ? 'warmup' : ''}" data-set-row="${exIdx}:${setIdx}">
      <span class="set-row-num">${set.isWarmup ? 'W' : setIdx + 1 - ex.sets.filter((s, i) => s.isWarmup && i < setIdx).length}</span>
      <input type="number" inputmode="decimal" min="0" max="999" step="0.5" placeholder="${weightPlaceholder}" value="${set.weight ?? ''}" data-set-field="${exIdx}:${setIdx}:weight" />
      <input type="number" inputmode="numeric" min="1" max="100" step="1" placeholder="${repsPlaceholder}" value="${set.reps ?? ''}" data-set-field="${exIdx}:${setIdx}:reps" />
      <button type="button" class="set-effort-btn ${isNA ? 'na' : ''} ${!isNA && set.rpe == null ? 'placeholder' : ''}" data-effort="${exIdx}:${setIdx}" ${isNA ? 'disabled' : ''} aria-label="How did this set feel?">${effortAbbr}</button>
      <button class="set-check-btn ${set.completed ? 'checked' : ''}" data-complete-set="${exIdx}:${setIdx}" aria-label="${set.completed ? 'Set logged — tap to edit' : 'Log set as planned'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </button>
    </div>
    ${showPlates && plateWeight != null && plateHint(plateWeight) ? `<div class="set-plate-hint mono">${plannedWeight != null && set.weight == null ? `planned ${plannedWeight} · ` : ''}${plateHint(plateWeight)}</div>` : ''}
  `;
}

function refreshExerciseCard(exIdx) {
  const container = document.getElementById('active-exercises');
  if (!container || !container.children[exIdx]) return;
  container.children[exIdx].innerHTML = renderActiveExercise(State.activeWorkout.exercises[exIdx], exIdx);
  wireExerciseCard(container.children[exIdx]);
}

function wireExerciseCard(root) {
  root.querySelectorAll('[data-set-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const [exIdx, setIdx, field] = input.dataset.setField.split(':');
      const set = State.activeWorkout.exercises[exIdx].sets[setIdx];
      const raw = parseFloat(input.value);
      set[field] = Number.isFinite(raw) ? clamp(raw, 0, 999) : null;
    });
    // Establishing an ad-hoc exercise's target from its first typed reps
    // happens on 'change' (fires once, on blur — the FINAL value), not on
    // every keystroke of 'input'. Reps often take two keystrokes ("1" then
    // "2" for 12); doing this on 'input' locked the target to whatever the
    // FIRST keystroke parsed to, and that wrong number then propagated to
    // every other set's placeholder and auto-filled completion.
    input.addEventListener('change', () => {
      const [exIdx, setIdx, field] = input.dataset.setField.split(':');
      if (field !== 'reps') return;
      const ex = State.activeWorkout.exercises[exIdx];
      const set = ex.sets[setIdx];
      if (ex.targetRepsLow == null && set.reps != null) {
        ex.targetRepsLow = set.reps; ex.targetRepsHigh = set.reps;
        recomputeExerciseTargets(ex);
        refreshExerciseCard(Number(exIdx));
      }
    });
  });

  root.querySelectorAll('[data-effort]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [exIdx, setIdx] = btn.dataset.effort.split(':').map(Number);
      openEffortModal(exIdx, setIdx);
    }));

  root.querySelectorAll('[data-complete-set]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [exIdx, setIdx] = btn.dataset.completeSet.split(':').map(Number);
      const ex = State.activeWorkout.exercises[exIdx];
      const set = ex.sets[setIdx];
      if (set.completed) { set.completed = false; refreshExerciseCard(exIdx); return; }
      const stillMissing = set.isWarmup
        ? (set.weight == null || set.reps == null)
        : (set.weight == null || set.reps == null || set.rpe == null);
      if (stillMissing) {
        const fill = autofillForSet(ex, setIdx);
        if ((!fill || fill.weight == null) && set.weight == null) { showToast('Enter a weight to log this set'); return; }
        if (set.weight == null) set.weight = fill.weight;
        if (set.reps == null) set.reps = (fill && fill.reps) ?? set.reps;
        if (!set.isWarmup && set.rpe == null) set.rpe = (fill && fill.rpe) ?? ex.targetRPE;
        if (set.reps == null) { showToast('Enter reps to log this set'); return; }
      }
      set.completed = true;
      autoregulateSetCount(exIdx, setIdx);
      refreshExerciseCard(exIdx);
      startRestTimer(set.rpe, set.isWarmup, set.reps);
    }));

  root.querySelectorAll('[data-add-set]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.addSet);
      State.activeWorkout.exercises[exIdx].sets.push({ weight: null, reps: null, rpe: null, completed: false, isWarmup: false });
      refreshExerciseCard(exIdx);
    }));

  root.querySelectorAll('[data-remove-ex]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.removeEx);
      const removed = State.activeWorkout.exercises.splice(exIdx, 1)[0];
      render();
      showToast('Exercise removed', {
        actionLabel: 'Undo',
        onAction: () => { State.activeWorkout.exercises.splice(exIdx, 0, removed); render(); },
      });
    }));
}

function openEffortModal(exIdx, setIdx) {
  openModal({
    title: 'How did that set feel?',
    body: `
      <div class="effort-grid">
        ${EFFORT_TIERS.map((t) => `<button class="effort-choice" data-tier="${t.id}"><strong>${t.label}</strong><span class="mono text-xs">RPE ${t.rangeLabel}</span></button>`).join('')}
      </div>`,
    onOpen: (root) => {
      root.querySelectorAll('[data-tier]').forEach((btn) =>
        btn.addEventListener('click', () => {
          State.activeWorkout.exercises[exIdx].sets[setIdx].rpe = effortTierToRPE(btn.dataset.tier);
          closeModal();
          refreshExerciseCard(exIdx);
        }));
    },
  });
}

async function finishWorkout() {
  const w = State.activeWorkout;
  w.exercises = w.exercises
    .map((ex) => ({ ...ex, sets: ex.sets.filter((s) => s.completed) }))
    .filter((ex) => ex.sets.length > 0);
  if (w.exercises.length === 0) { showToast('Log at least one set before finishing'); return; }
  dismissRestTimer();
  await dbPut('sessions', w);
  State.sessions.unshift(w);
  State.activeWorkout = null;
  render();
  showToast('Workout saved');
}

/* ---------------- Lift picker (add exercise / template editor) ---------------- */
function openLiftPicker(onPick) {
  openModal({
    title: 'Add exercise',
    body: `
      <input type="search" id="lift-search" placeholder="Search lifts…" autocomplete="off" />
      <div id="lift-results" class="lift-results"></div>
      <button class="btn btn-outline mt-4" id="btn-new-lift">+ New lift</button>`,
    onOpen: (root) => {
      const results = root.querySelector('#lift-results');
      const renderResults = (q) => {
        const query = (q || '').toLowerCase();
        const matches = State.lifts
          .filter((l) => l.name.toLowerCase().includes(query))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 40);
        results.innerHTML = matches.map((l) => {
          const e1rm = getLiftCurrentE1RM(l.id);
          const jump = getLiftIncrement(l);
          return `
          <div class="lift-result-row">
            <button class="row-btn" data-pick-lift="${l.id}">
              <span>${escapeHTML(l.name)}</span>
              <span class="text-xs text-faint mono">${e1rm ? `e1RM ${e1rm} · ` : ''}jump ${jump}</span>
            </button>
            <button class="icon-btn" data-edit-lift="${l.id}" aria-label="Edit ${escapeHTML(l.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
          </div>`;
        }).join('') || '<p class="text-sm text-faint">No matches.</p>';
        results.querySelectorAll('[data-pick-lift]').forEach((btn) =>
          btn.addEventListener('click', () => { closeModal(); onPick(btn.dataset.pickLift); }));
        results.querySelectorAll('[data-edit-lift]').forEach((btn) =>
          btn.addEventListener('click', () => openLiftForm(getLift(btn.dataset.editLift), () => openLiftPicker(onPick))));
      };
      renderResults('');
      root.querySelector('#lift-search').addEventListener('input', (e) => renderResults(e.target.value));
      root.querySelector('#btn-new-lift').addEventListener('click', () => openLiftForm(null, onPick));
    },
  });
}

/**
 * Create OR edit a lift — same form either way. `onDone(liftId)` fires
 * after save: for a brand-new lift that's the calling flow's onPick
 * (selects it straight into whatever's being built, same as before this
 * form existed); for an edit it's a closure that just reopens the picker,
 * so the edit is a detour from Add Exercise rather than a dead end.
 */
function openLiftForm(existingLift, onDone) {
  const isEdit = !!existingLift;
  openModal({
    title: isEdit ? 'Edit lift' : 'New lift',
    body: `
      <div class="field"><label for="lift-name">Name</label><input type="text" id="lift-name" value="${isEdit ? escapeHTML(existingLift.name) : ''}" placeholder="e.g. Pause Squat" /></div>
      <label class="toggle-row"><span>Compound (multi-joint)</span><input type="checkbox" id="lift-compound" ${!isEdit || existingLift.isCompound ? 'checked' : ''} /></label>
      <label class="toggle-row"><span>Assisted machine (number = assistance)</span><input type="checkbox" id="lift-assisted" ${isEdit && existingLift.isAssisted ? 'checked' : ''} /></label>
      <div class="field">
        <label for="lift-increment">Load jump override (lb)</label>
        <input type="number" inputmode="decimal" min="0" step="0.5" id="lift-increment" value="${isEdit && existingLift.loadIncrement != null ? existingLift.loadIncrement : ''}" placeholder="blank = category default" />
        <div class="field-hint">How big a weight change THIS lift jumps by when a set comes in easy or hard — e.g. a squat can jump by a full plate, a gripper should move in much smaller steps. Leave blank to use the compound/isolation default from Settings (currently ${State.settings.compoundIncrement ?? 5} / ${State.settings.isolationIncrement ?? 2.5}).</div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="lift-save">${isEdit ? 'Save Lift' : 'Add Lift'}</button></div>`,
    onOpen: (root) => {
      root.querySelector('#lift-save').addEventListener('click', async () => {
        const name = root.querySelector('#lift-name').value.trim();
        if (!name) { showToast('Give the lift a name'); return; }
        const rawInc = root.querySelector('#lift-increment').value.trim();
        const parsedInc = parseFloat(rawInc);
        const loadIncrement = rawInc === '' ? null : (Number.isFinite(parsedInc) && parsedInc > 0 ? parsedInc : null);
        const lift = {
          ...(isEdit ? existingLift : { id: uid(), groups: [], custom: true, createdAt: todayISO() }),
          name,
          isCompound: root.querySelector('#lift-compound').checked,
          isAssisted: root.querySelector('#lift-assisted').checked,
          loadIncrement,
        };
        await dbPut('lifts', lift);
        const idx = State.lifts.findIndex((l) => l.id === lift.id);
        if (idx >= 0) State.lifts[idx] = lift; else State.lifts.push(lift);
        closeModal();
        onDone(lift.id);
      });
    },
  });
}

/* ---------------- Plan ---------------- */
function renderPlan() {
  const plan = getWeeklyPlan();
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday-first week
  return `
    <span class="section-label">Week</span>
    <div class="card">
      ${order.map((d) => {
        const tpl = plan[d] ? getTemplateById(plan[d]) : null;
        return `<button class="plan-day" data-plan-day="${d}">
          <span class="plan-day-name">${DOW[d].slice(0, 3)}</span>
          <span class="${tpl ? '' : 'text-faint'}">${tpl ? escapeHTML(tpl.name) : 'Rest'}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="flex-between" style="margin-top: var(--space-5)">
      <span class="section-label" style="margin:0">Sessions</span>
      <button class="btn btn-ghost btn-sm" id="btn-new-template">+ New</button>
    </div>
    ${State.templates.map((t) => `
      <button class="row-btn" data-edit-template="${t.id}">
        <span>${escapeHTML(t.name)}</span>
        <span class="text-xs text-faint">${(t.exercises || []).length} lifts</span>
      </button>`).join('') || '<p class="text-sm text-faint">No sessions yet — create one to schedule your week.</p>'}
  `;
}

function openPlanDayPicker(dow) {
  openModal({
    title: `${DOW[dow]}`,
    body: `
      <button class="row-btn" data-day-pick=""><span class="text-muted">Rest</span></button>
      ${State.templates.map((t) => `<button class="row-btn" data-day-pick="${t.id}"><span>${escapeHTML(t.name)}</span></button>`).join('')}`,
    onOpen: (root) => {
      root.querySelectorAll('[data-day-pick]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          await setPlanDay(dow, btn.dataset.dayPick || null);
          closeModal();
          render();
        }));
    },
  });
}

/* ---------------- Template editor ---------------- */
let editorDraft = null; // deep-copied template being edited

function openTemplateEditor(template) {
  editorDraft = template
    ? JSON.parse(JSON.stringify(template))
    : { id: uid(), name: '', exercises: [], createdAt: todayISO() };
  renderTemplateEditor();
}

function renderTemplateEditor() {
  openModal({
    title: editorDraft.name ? 'Edit session' : 'New session',
    body: `
      <div class="field"><label for="tpl-name">Name</label><input type="text" id="tpl-name" value="${escapeHTML(editorDraft.name)}" placeholder="e.g. Squat Day" /></div>
      <div id="tpl-exercises">
        ${editorDraft.exercises.map((e, i) => {
          const lift = getLift(e.liftId);
          return `
          <div class="tpl-ex-row">
            <div class="tpl-ex-main">
              <strong>${lift ? escapeHTML(lift.name) : 'Unknown lift'}</strong>
              <div class="tpl-ex-fields mono">
                <input type="number" min="1" max="12" value="${e.targetSets}" data-tpl-field="${i}:targetSets" aria-label="Sets" /> ×
                <input type="number" min="1" max="30" value="${e.targetRepsLow}" data-tpl-field="${i}:targetRepsLow" aria-label="Reps low" /> –
                <input type="number" min="1" max="30" value="${e.targetRepsHigh}" data-tpl-field="${i}:targetRepsHigh" aria-label="Reps high" />
                <label class="tpl-warmup"><input type="checkbox" ${e.warmupEnabled ? 'checked' : ''} data-tpl-warmup="${i}" /> warm-up</label>
              </div>
            </div>
            <div class="tpl-ex-actions">
              <button class="icon-btn" data-tpl-move="${i}:-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="icon-btn" data-tpl-move="${i}:1" aria-label="Move down" ${i === editorDraft.exercises.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="icon-btn" data-tpl-remove="${i}" aria-label="Remove">✕</button>
            </div>
          </div>`;
        }).join('') || '<p class="text-sm text-faint">No exercises yet.</p>'}
      </div>
      <button class="btn btn-outline" id="tpl-add-ex">+ Add exercise</button>
      <div class="modal-actions">
        ${getTemplateById(editorDraft.id) ? '<button class="btn btn-danger-ghost" id="tpl-delete">Delete</button>' : ''}
        <button class="btn btn-primary" id="tpl-save">Save Session</button>
      </div>`,
    onOpen: (root) => {
      root.querySelector('#tpl-name').addEventListener('input', (e) => { editorDraft.name = e.target.value; });
      root.querySelectorAll('[data-tpl-field]').forEach((input) =>
        input.addEventListener('input', () => {
          const [i, field] = input.dataset.tplField.split(':');
          const v = parseInt(input.value, 10);
          if (Number.isFinite(v)) editorDraft.exercises[i][field] = clamp(v, 1, field === 'targetSets' ? 12 : 30);
        }));
      root.querySelectorAll('[data-tpl-warmup]').forEach((cb) =>
        cb.addEventListener('change', () => { editorDraft.exercises[cb.dataset.tplWarmup].warmupEnabled = cb.checked; }));
      root.querySelectorAll('[data-tpl-move]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const [i, dir] = btn.dataset.tplMove.split(':').map(Number);
          const j = i + dir;
          if (j < 0 || j >= editorDraft.exercises.length) return;
          [editorDraft.exercises[i], editorDraft.exercises[j]] = [editorDraft.exercises[j], editorDraft.exercises[i]];
          renderTemplateEditor();
        }));
      root.querySelectorAll('[data-tpl-remove]').forEach((btn) =>
        btn.addEventListener('click', () => { editorDraft.exercises.splice(Number(btn.dataset.tplRemove), 1); renderTemplateEditor(); }));
      root.querySelector('#tpl-add-ex').addEventListener('click', () =>
        openLiftPicker((liftId) => {
          editorDraft.exercises.push(defaultTemplateExercise(liftId));
          renderTemplateEditor();
        }));
      root.querySelector('#tpl-save').addEventListener('click', async () => {
        if (!editorDraft.name.trim()) { showToast('Give the session a name'); return; }
        if (editorDraft.exercises.length === 0) { showToast('Add at least one exercise'); return; }
        editorDraft.name = editorDraft.name.trim();
        delete editorDraft.preset;
        await dbPut('templates', editorDraft);
        const idx = State.templates.findIndex((t) => t.id === editorDraft.id);
        if (idx >= 0) State.templates[idx] = editorDraft; else State.templates.push(editorDraft);
        closeModal();
        render();
        showToast('Session saved');
      });
      const del = root.querySelector('#tpl-delete');
      if (del) del.addEventListener('click', () =>
        confirmModal('Delete this session?', 'Its logged history stays — only the plan entry is removed.', 'Delete Session', async () => {
          await dbDelete('templates', editorDraft.id);
          State.templates = State.templates.filter((t) => t.id !== editorDraft.id);
          const plan = getWeeklyPlan();
          for (let d = 0; d <= 6; d++) if (plan[d] === editorDraft.id) plan[d] = null;
          State.settings.weeklyPlan = plan;
          await saveSettings();
          render();
          showToast('Session deleted');
        }, true));
    },
  });
}

/* ---------------- History ---------------- */
function renderHistory() {
  if (State.sessions.length === 0) {
    return '<p class="text-sm text-faint" style="margin-top:var(--space-6)">No sessions yet — your first logged workout lands here.</p>';
  }
  return `
    <span class="section-label">History</span>
    ${State.sessions.slice(0, 100).map((s) => {
      const setCount = (s.exercises || []).reduce((n, ex) => n + (ex.sets || []).filter((x) => x.completed && !x.isWarmup).length, 0);
      return `<button class="row-btn" data-open-session="${s.id}">
        <span>${escapeHTML(s.name)}</span>
        <span class="text-xs text-faint mono">${fmtDate(s.date)} · ${setCount} sets</span>
      </button>`;
    }).join('')}
  `;
}

function openSessionDetail(sessionId) {
  const s = State.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  openModal({
    title: `${s.name} — ${fmtDate(s.date)}`,
    body: `
      ${(s.exercises || []).map((ex) => {
        const lift = getLift(ex.liftId);
        return `
        <div class="detail-ex">
          <strong>${lift ? escapeHTML(lift.name) : 'Unknown lift'}</strong>
          ${(ex.sets || []).filter((x) => x.completed).map((set) => `
            <div class="detail-set mono">${set.isWarmup ? 'W' : ''} ${set.weight ?? '—'} × ${set.reps ?? '—'}${set.rpe != null ? ` @ ${effortTierAbbr(set.rpe)}` : ''}</div>`).join('')}
        </div>`;
      }).join('')}
      <div class="modal-actions"><button class="btn btn-danger-ghost" id="session-delete">Delete Session</button></div>`,
    onOpen: (root) => {
      root.querySelector('#session-delete').addEventListener('click', () =>
        confirmModal('Delete this session?', 'Its sets leave your e1RM history permanently.', 'Delete Session', async () => {
          await dbDelete('sessions', sessionId);
          State.sessions = State.sessions.filter((x) => x.id !== sessionId);
          render();
          showToast('Session deleted');
        }, true));
    },
  });
}

/* ---------------- Settings ---------------- */
function openSettings() {
  const s = State.settings;
  const plan = getBlockPlan();
  const block = getCurrentBlock();
  openModal({
    title: 'Settings',
    body: `
      <div class="field"><label for="set-bw">Bodyweight (lb)</label><input type="number" inputmode="decimal" id="set-bw" value="${s.weightLb ?? ''}" placeholder="e.g. 200" /></div>
      <span class="section-label">Load jumps</span>
      <div class="field"><label for="set-inc-compound">Compound lift jump (lb)</label><input type="number" inputmode="decimal" id="set-inc-compound" value="${s.compoundIncrement ?? 5}" /></div>
      <div class="field">
        <label for="set-inc-isolation">Isolation/accessory jump (lb)</label>
        <input type="number" inputmode="decimal" id="set-inc-isolation" value="${s.isolationIncrement ?? 2.5}" />
        <div class="field-hint">These are the defaults for how big a weight change the app suggests — a big barbell lift moves in whole plates, a small cable or grip lift moves finer. Any single lift can override its own jump size from Edit Lift.</div>
      </div>
      <span class="section-label">Training block</span>
      <div class="field"><label for="set-weeks">Cycle length (weeks)</label><input type="number" min="1" max="20" id="set-weeks" value="${plan.weeks}" /></div>
      <div class="field">
        <label for="set-week">Current week (1–${plan.weeks})</label>
        <input type="number" min="1" max="${plan.weeks}" id="set-week" value="${block.weekInCycle}" />
        <div class="field-hint">Phases auto-distribute: Accumulation → Intensification → Max → Deload. This week: ${block.phase}. RPE targets follow the phase; readiness fine-tunes load daily.</div>
      </div>
      <span class="section-label">App</span>
      <label class="toggle-row"><span>Dark theme</span><input type="checkbox" id="set-theme" ${document.documentElement.dataset.theme === 'dark' ? 'checked' : ''} /></label>
      <div class="modal-actions">
        <button class="btn btn-outline" id="btn-export">Export Backup</button>
        <button class="btn btn-outline" id="btn-import">Import Backup</button>
      </div>
      <input type="file" id="import-file" accept="application/json" style="display:none" />
      <div class="modal-actions"><button class="btn btn-primary" id="settings-save">Save Settings</button></div>`,
    onOpen: (root) => {
      root.querySelector('#settings-save').addEventListener('click', async () => {
        const bw = parseFloat(root.querySelector('#set-bw').value);
        const incCompound = parseFloat(root.querySelector('#set-inc-compound').value);
        const incIsolation = parseFloat(root.querySelector('#set-inc-isolation').value);
        const weeks = clamp(parseInt(root.querySelector('#set-weeks').value, 10) || DEFAULT_CYCLE_WEEKS, 1, 20);
        const week = clamp(parseInt(root.querySelector('#set-week').value, 10) || 1, 1, weeks);
        State.settings.weightLb = Number.isFinite(bw) ? bw : null;
        State.settings.compoundIncrement = Number.isFinite(incCompound) && incCompound > 0 ? incCompound : 5;
        State.settings.isolationIncrement = Number.isFinite(incIsolation) && incIsolation > 0 ? incIsolation : 2.5;
        State.settings.blockPlan = { weeks, auto: true, customPhases: [], anchorDate: todayISO(), anchorWeek: week };
        await saveSettings();
        closeModal();
        render();
        showToast('Settings saved');
      });
      root.querySelector('#set-theme').addEventListener('change', (e) => {
        const theme = e.target.checked ? 'dark' : 'light';
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('autoreg-theme', theme);
      });
      root.querySelector('#btn-export').addEventListener('click', exportBackup);
      const fileInput = root.querySelector('#import-file');
      root.querySelector('#btn-import').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => { if (fileInput.files[0]) importBackup(fileInput.files[0]); });
    },
  });
}

/* ---------------- Local backup (keyless, offline) ---------------- */
async function exportBackup() {
  const data = {
    app: 'autoreg', exportedAt: new Date().toISOString(),
    lifts: await dbGetAll('lifts'), sessions: await dbGetAll('sessions'),
    templates: await dbGetAll('templates'), checkins: await dbGetAll('checkins'),
    symptoms: await dbGetAll('symptoms'), settings: await dbGetAll('settings'),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `autoreg-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Backup downloaded');
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { showToast('Not a valid backup file'); return; }
  if (!data || data.app !== 'autoreg' || !Array.isArray(data.sessions)) { showToast('Not an AutoReg backup'); return; }
  confirmModal('Restore this backup?', `Replaces everything on this device with ${data.sessions.length} sessions from ${data.exportedAt ? data.exportedAt.slice(0, 10) : 'the file'}.`, 'Restore', async () => {
    for (const store of ['lifts', 'sessions', 'templates', 'checkins', 'symptoms', 'settings']) {
      const existing = await dbGetAll(store);
      const keyPath = store === 'checkins' ? 'date' : store === 'settings' ? 'key' : 'id';
      for (const rec of existing) await dbDelete(store, rec[keyPath]);
      for (const rec of data[store] || []) await dbPut(store, rec);
    }
    await loadAllState();
    render();
    showToast('Backup restored');
  }, true);
}

/* ---------------- View wiring ---------------- */
function wireView() {
  document.querySelectorAll('[data-readiness]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await setTodayReadiness(parseInt(btn.dataset.readiness, 10));
      render();
    }));

  document.querySelectorAll('[data-start-template]').forEach((btn) =>
    btn.addEventListener('click', () => startWorkout(getTemplateById(btn.dataset.startTemplate))));

  const startEmpty = document.getElementById('btn-start-empty');
  if (startEmpty) startEmpty.addEventListener('click', () => startWorkout(null));

  const cancelBtn = document.getElementById('btn-cancel-workout');
  if (cancelBtn) cancelBtn.addEventListener('click', () =>
    confirmModal('Discard workout?', 'Any logged sets will be lost.', 'Discard', () => {
      State.activeWorkout = null;
      dismissRestTimer();
      render();
    }, true));

  const finishBtn = document.getElementById('btn-finish-workout');
  if (finishBtn) finishBtn.addEventListener('click', finishWorkout);

  const intensityBtn = document.getElementById('btn-intensity');
  if (intensityBtn) intensityBtn.addEventListener('click', openIntensityModal);

  const addExBtn = document.getElementById('btn-add-exercise');
  if (addExBtn) addExBtn.addEventListener('click', () =>
    openLiftPicker((liftId) => {
      State.activeWorkout.exercises.push(buildActiveExercise(liftId, 3, null, null, false));
      render();
    }));

  document.querySelectorAll('#active-exercises > .ex-wrap').forEach((wrap) => wireExerciseCard(wrap));

  document.querySelectorAll('[data-plan-day]').forEach((btn) =>
    btn.addEventListener('click', () => openPlanDayPicker(parseInt(btn.dataset.planDay, 10))));

  const newTpl = document.getElementById('btn-new-template');
  if (newTpl) newTpl.addEventListener('click', () => openTemplateEditor(null));

  document.querySelectorAll('[data-edit-template]').forEach((btn) =>
    btn.addEventListener('click', () => openTemplateEditor(getTemplateById(btn.dataset.editTemplate))));

  document.querySelectorAll('[data-open-session]').forEach((btn) =>
    btn.addEventListener('click', () => openSessionDetail(btn.dataset.openSession)));
}

/* ---------------- Boot ---------------- */
function initTheme() {
  const saved = localStorage.getItem('autoreg-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
}

async function boot() {
  initTheme();
  await loadAllState();
  document.getElementById('tab-bar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    State.currentTab = tab.dataset.tab;
    render();
  });
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('phase-pill').addEventListener('click', openSettings);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
