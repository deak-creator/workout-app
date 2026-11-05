let EXERCISES = [];
let currentWorkout = null;
let currentPlan = null;
let lastParams = null;
let activeWeekIndex = 0;
let activePlanDayIndex = null; // null = jump to the first unfinished day

const ALL_EQUIPMENT = ["bodyweight", "dumbbells", "bands", "kettlebell", "pullup bar", "barbell", "cable machine", "bench", "machine"];
const HOME_EQUIPMENT = ["bodyweight", "dumbbells", "bands", "kettlebell", "pullup bar"];
const GYM_EQUIPMENT = ALL_EQUIPMENT; // gyms typically have everything, including home-friendly gear

// At the gym, home-style gear is still allowed but should rarely win: prefer barbell/cable/bench work.
const GYM_EQUIPMENT_BIAS = { barbell: 3, "cable machine": 3, bench: 3, machine: 2.5, dumbbells: 2.5, kettlebell: 0.5, "pullup bar": 0, bands: -3, bodyweight: -2 };

function isGymSession(params) {
  if (params.location) return params.location === "gym";
  const eq = params.equipment instanceof Set ? params.equipment : new Set(params.equipment || []);
  return eq.has("barbell") || eq.has("cable machine");
}

// Only strength picks are biased: cardio/core/mobility are mostly bodyweight in the library.
function gymEquipmentBias(ex, atGym) {
  if (!atGym || ex.type !== "strength") return 0;
  return GYM_EQUIPMENT_BIAS[ex.equipment] ?? 0;
}

const state = {
  mode: "quick",
  goal: "general",
  duration: "30",
  difficulty: "beginner",
  weeks: "2",
  daysPerWeek: "4",
  location: "home"
};

const DIFF_RANK = { beginner: 1, intermediate: 2, advanced: 3 };

fetch("data/exercises.json")
  .then(r => r.json())
  .then(data => { EXERCISES = data; });

// ---------- chip / mode-toggle selection logic ----------
document.querySelectorAll(".chip-group").forEach(group => {
  const field = group.dataset.field;
  const isMulti = group.classList.contains("multi");
  group.addEventListener("click", e => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    const value = btn.dataset.value;

    if (isMulti) {
      if (btn.classList.contains("selected")) {
        btn.classList.remove("selected");
        state[field].delete(value);
      } else {
        btn.classList.add("selected");
        state[field].add(value);
      }
    } else {
      group.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
      btn.classList.add("selected");
      state[field] = value;
    }
  });
});

document.querySelector(".mode-toggle").addEventListener("click", e => {
  const btn = e.target.closest(".mode-btn");
  if (!btn) return;
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
  applySetupMode(btn.dataset.value);
});

// Show the Build form sections for Quick Workout / Multi-Week Plan / Build My Own
function applySetupMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach(b => {
    b.classList.toggle("selected", b.dataset.value === mode);
    b.setAttribute("aria-selected", String(b.dataset.value === mode));
  });
  document.querySelectorAll(".plan-only").forEach(el => el.hidden = mode !== "plan");
  document.querySelectorAll(".quick-only").forEach(el => el.hidden = mode !== "quick");
  document.querySelectorAll(".custom-only").forEach(el => el.hidden = mode !== "custom");
  document.querySelectorAll(".not-custom").forEach(el => el.hidden = mode === "custom");
  document.getElementById("duration-label").textContent = mode === "plan" ? "Minutes per day" : "Duration";
  document.getElementById("generate-btn").textContent =
    mode === "plan" ? "Generate Plan" : mode === "custom" ? "Start Building" : "Generate Workout";
}

// ---------- tab navigation ----------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === "saved-screen") savedFolder = null;
    showTab(btn.dataset.tab);
  });
});
function showTab(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  if (id === "saved-screen") renderSaved();
}

document.getElementById("back-btn").addEventListener("click", () => showTab("setup-screen"));
document.getElementById("plan-back-btn").addEventListener("click", () => showTab("setup-screen"));
document.getElementById("regen-btn").addEventListener("click", () => {
  if (lastParams) renderWorkout(generateWorkout(lastParams));
});

// ---------- form submit ----------
document.getElementById("setup-form").addEventListener("submit", e => {
  e.preventDefault();
  if (state.mode === "custom") { startCustomWorkout(); return; }
  const goalPrompt = (document.getElementById("goal-prompt-input").value || "").trim();
  const promptBias = parseGoalPrompt(goalPrompt);
  const params = {
    goal: state.goal,
    duration: parseInt(state.duration, 10),
    difficulty: state.difficulty,
    equipment: new Set(state.location === "gym" ? GYM_EQUIPMENT : HOME_EQUIPMENT),
    location: state.location,
    muscles: new Set(),
    goalPrompt,
    promptBias
  };

  if (state.mode === "plan") {
    const planParams = {
      ...params,
      weeks: parseInt(state.weeks, 10),
      daysPerWeek: parseInt(state.daysPerWeek, 10)
    };
    lastParams = planParams;
    currentPlan = generatePlan(planParams);
    activeWeekIndex = 0;
    activePlanDayIndex = null;
    renderPlan(currentPlan);
    showTab("plan-screen");
  } else {
    lastParams = params;
    const workout = generateWorkout(params);
    renderWorkout(workout);
    showTab("workout-screen");
  }
});

// live hint under the free-text prompt so it's clear the text is actually read
document.getElementById("goal-prompt-input").addEventListener("input", e => {
  const bias = parseGoalPrompt(e.target.value);
  const hintEl = document.getElementById("goal-prompt-hint");
  const parts = [];
  if (bias.repStyle === "hypertrophy") parts.push("Biasing toward lean-muscle rep ranges (8-15 reps) and more strength days");
  else if (bias.repStyle === "strength") parts.push("Biasing toward heavy strength rep ranges (4-8 reps) and more strength days");
  if (bias.lessCardio) parts.push("Reducing cardio days");
  if (bias.muscleFocus.length) parts.push(`Prioritising: ${bias.muscleFocus.join(", ")}`);
  hintEl.textContent = parts.join(" · ");
});

// ============================================================
// DAY-TYPE ROTATION — each day in a plan is a different kind of workout
// (Strength / Cardio / Fat Loss / Mobility). Strength days are then given a
// muscle-group focus (Push / Pull / Legs / Upper / Lower) so one session sticks
// to related muscles instead of hitting everything.
// ============================================================
const DAY_TYPE_LABELS = {
  strength: "Strength",
  cardio: "Cardio",
  fatloss: "Fat Loss",
  mobility: "Mobility"
};

// Rotation order chosen so strength days aren't back-to-back and every
// plan gets a healthy mix no matter how many days per week is picked.
// Cardio is its own section (v37), so plan days rotate strength / fat loss / mobility only.
const ROTATION_ORDER = ["strength", "fatloss", "strength", "mobility", "strength", "fatloss", "strength"];

// ---------- free-text goal prompt parsing ----------
// Reads the "Anything specific you want to achieve?" box and turns it into a
// rotation bias + rep-range style so a request like "build lean muscle, less
// cardio, focus on back" actually changes what gets generated, not just the
// workout-type label.
const GOAL_PROMPT_KEYWORDS = {
  muscle: ["muscle", "lean", "bulk", "hypertroph", "tone", "build", "gain", "size", "bigger"],
  strength: ["strength", "strong", "powerlift", "heavy", "1rm", "max"],
  lessCardio: ["less cardio", "no cardio", "less running", "minimal cardio", "avoid cardio"],
  cardio: ["cardio", "endurance", "run", "stamina", "conditioning"],
  fatloss: ["fat loss", "lose weight", "lean out", "cut", "shred", "slim"],
  mobility: ["mobility", "flexib", "stretch", "yoga"]
};
const MUSCLE_KEYWORDS = {
  back: ["back", "lats", "pull"],
  chest: ["chest", "pecs", "push"],
  shoulders: ["shoulders", "delts"],
  arms: ["arms", "biceps", "triceps"],
  legs: ["legs", "quads", "hamstrings", "glutes", "lower body"],
  core: ["core", "abs", "six pack"],
  "upper body": ["upper body"]
};

function parseGoalPrompt(text) {
  const result = { typeBias: { strength: 0, cardio: 0, fatloss: 0, mobility: 0 }, muscleFocus: [], repStyle: null, lessCardio: false };
  if (!text) return result;
  const t = text.toLowerCase();

  if (GOAL_PROMPT_KEYWORDS.muscle.some(k => t.includes(k))) {
    result.typeBias.strength += 3;
    result.repStyle = "hypertrophy";
  }
  if (GOAL_PROMPT_KEYWORDS.strength.some(k => t.includes(k))) {
    result.typeBias.strength += 3;
    if (!result.repStyle) result.repStyle = "strength";
  }
  if (GOAL_PROMPT_KEYWORDS.cardio.some(k => t.includes(k))) {
    result.typeBias.cardio += 2;
  }
  if (GOAL_PROMPT_KEYWORDS.fatloss.some(k => t.includes(k))) {
    result.typeBias.fatloss += 2;
  }
  if (GOAL_PROMPT_KEYWORDS.mobility.some(k => t.includes(k))) {
    result.typeBias.mobility += 2;
  }
  if (GOAL_PROMPT_KEYWORDS.lessCardio.some(k => t.includes(k))) {
    result.lessCardio = true;
    result.typeBias.cardio -= 3;
    result.typeBias.fatloss -= 1;
  }
  Object.entries(MUSCLE_KEYWORDS).forEach(([muscle, keys]) => {
    if (keys.some(k => t.includes(k))) result.muscleFocus.push(muscle);
  });
  return result;
}

// Build a rotation of day types weighted by the prompt's bias — e.g. a strong
// "build muscle" signal yields more strength days and fewer/no cardio days,
// instead of always forcing the fixed strength/cardio/fatloss/mobility cycle.
function buildBiasedRotation(daysPerWeek, promptBias) {
  const baseWeights = { strength: 3, fatloss: 2, mobility: 1 }; // no cardio days: cardio has its own section
  const weights = { ...baseWeights };
  Object.keys(weights).forEach(k => {
    weights[k] = Math.max(0.2, weights[k] + (promptBias.typeBias[k] || 0));
  });
  const types = Object.keys(weights);
  const totalWeight = types.reduce((s, k) => s + weights[k], 0);
  // deterministic-ish round-robin weighted pick so the same prompt gives a
  // consistent, well-distributed rotation rather than pure randomness
  const counts = {};
  types.forEach(k => { counts[k] = 0; });
  const order = [];
  for (let i = 0; i < daysPerWeek; i++) {
    let best = types[0];
    let bestScore = -Infinity;
    types.forEach(k => {
      if (weights[k] <= 0) return;
      const score = weights[k] / totalWeight - counts[k] / (i + 1);
      if (score > bestScore) { bestScore = score; best = k; }
    });
    order.push(best);
    counts[best]++;
  }
  return order;
}

// Muscle groups for strength-day splits, matched on an exercise's primary (first) muscle.
const PUSH_MUSCLES = ["chest", "shoulders", "triceps"];
const PULL_MUSCLES = ["back", "biceps", "lower back", "forearms"];
const LEG_MUSCLES = ["quads", "hamstrings", "glutes", "hips", "inner thighs", "hip flexors", "calves"];
const MUSCLE_SPLITS = {
  push: { label: "Push Day", muscles: PUSH_MUSCLES },
  pull: { label: "Pull Day", muscles: PULL_MUSCLES },
  legs: { label: "Leg Day", muscles: LEG_MUSCLES },
  upper: { label: "Upper Body", muscles: [...PUSH_MUSCLES, ...PULL_MUSCLES] },
  lower: { label: "Lower Body", muscles: LEG_MUSCLES },
  full: { label: "Full Body", muscles: null }
};
// How the week's strength days are split, by how many strength days there are.
const SPLIT_ORDER_BY_COUNT = {
  1: ["full"],
  2: ["upper", "lower"],
  3: ["push", "pull", "legs"],
  4: ["upper", "lower", "upper", "lower"],
  5: ["push", "pull", "legs", "upper", "lower"],
  6: ["push", "pull", "legs", "push", "pull", "legs"]
};

// Strength and Fat Loss days both lift weights, so both get a muscle-group focus.
function assignMuscleSplits(days) {
  const liftingDays = days.filter(d => (d.dayGoal === "strength" || d.dayGoal === "fatloss") && !d.isRest);
  const order = SPLIT_ORDER_BY_COUNT[Math.min(6, liftingDays.length)] || [];
  liftingDays.forEach((day, i) => {
    const split = MUSCLE_SPLITS[order[i] || "full"];
    day.label = day.dayGoal === "fatloss" ? `Fat Loss · ${split.label}` : split.label;
    day.muscleGroup = split.muscles;
  });
  return days;
}

// Strength picks inside the day's muscle group float to the top; others sink
// (core and non-strength moves are neutral so warm-ups/finishers still work).
// Fat Loss split day: alternate on-group weights with cardio/core so the label
// ("Fat Loss · Pull Day") stays true without losing the circuit feel.
function splitCircuitPicks(rankedPool, muscleGroup, count) {
  const lifts = pickUnique(rankedPool.filter(ex => muscleSplitBias(ex, muscleGroup) > 0), Math.ceil(count / 2));
  const conditioning = pickUnique(rankedPool.filter(ex => ex.type === "cardio" || ex.type === "core"), count - lifts.length);
  const out = [];
  for (let i = 0; out.length < lifts.length + conditioning.length; i++) {
    if (lifts[i]) out.push(lifts[i]);
    if (conditioning[i]) out.push(conditioning[i]);
  }
  return out.length ? out : pickUnique(rankedPool, count);
}

// inGroupBonus is lower on Fat Loss days so cardio still gets mixed into the circuit.
function muscleSplitBias(ex, muscleGroup, inGroupBonus = 8) {
  if (!muscleGroup || ex.type !== "strength" || !ex.muscles || !ex.muscles.length) return 0;
  return muscleGroup.includes(ex.muscles[0]) ? inGroupBonus : -8;
}

function getSplitTemplate(daysPerWeek, promptBias) {
  return assignMuscleSplits(getDayTypeTemplate(daysPerWeek, promptBias));
}

function getDayTypeTemplate(daysPerWeek, promptBias) {
  const bias = promptBias || parseGoalPrompt("");
  const hasBias = ["strength", "fatloss", "mobility"].some(k => bias.typeBias[k]);

  if (daysPerWeek >= 7) {
    // 7 days: six varied sessions + one rest/recovery day
    const order = hasBias ? buildBiasedRotation(6, bias) : ["strength", "fatloss", "strength", "mobility", "strength", "fatloss"];
    const days = order.map(dayGoal => ({ label: DAY_TYPE_LABELS[dayGoal], dayGoal }));
    days.push({ label: "Recovery", dayGoal: "mobility", isRest: true });
    return days;
  }
  if (hasBias) {
    const order = buildBiasedRotation(daysPerWeek, bias);
    return order.map(dayGoal => ({ label: DAY_TYPE_LABELS[dayGoal], dayGoal }));
  }
  const days = [];
  for (let i = 0; i < daysPerWeek; i++) {
    const dayGoal = ROTATION_ORDER[i % ROTATION_ORDER.length];
    days.push({ label: DAY_TYPE_LABELS[dayGoal], dayGoal });
  }
  return days;
}

function goalTypeWeights(goal, promptBias) {
  let weights;
  switch (goal) {
    case "strength": weights = { strength: 5, core: 1, cardio: 0, mobility: 1 }; break;
    case "cardio": weights = { cardio: 5, strength: 1, core: 1, mobility: 0 }; break;
    case "fatloss": weights = { cardio: 4, strength: 2, core: 2, mobility: 0 }; break;
    case "mobility": weights = { mobility: 5, core: 1, strength: 0, cardio: 0 }; break;
    default: weights = { strength: 2, cardio: 2, core: 2, mobility: 1 };
  }
  if (promptBias) {
    weights = { ...weights };
    weights.strength = Math.max(0, weights.strength + (promptBias.typeBias.strength || 0) * 0.6);
    weights.cardio = Math.max(0, weights.cardio + (promptBias.typeBias.cardio || 0) * 0.6);
    if (promptBias.lessCardio) weights.cardio = Math.max(0, weights.cardio - 2);
  }
  return weights;
}

function pickUnique(arr, n) {
  const out = [];
  const used = new Set();
  for (const ex of arr) {
    if (used.has(ex.name)) continue;
    used.add(ex.name);
    out.push(ex);
    if (out.length >= n) break;
  }
  return out;
}

function formatSetLabel(ex, seconds, repStyle) {
  if (ex.type === "strength") {
    if (repStyle === "strength") {
      // lower reps, implies heavier load for pure-strength focused prompts
      return seconds <= 30 ? "4-6 reps" : seconds <= 45 ? "5-8 reps" : "6-10 reps";
    }
    if (repStyle === "hypertrophy") {
      // classic muscle-building rep range
      return seconds <= 30 ? "8-10 reps" : seconds <= 45 ? "10-12 reps" : "12-15 reps";
    }
    const reps = seconds <= 30 ? "10-12 reps" : seconds <= 45 ? "12-15 reps" : "15-20 reps";
    return reps;
  }
  return `${seconds}s`;
}

// ============================================================
// SINGLE-DAY WORKOUT GENERATOR (used by Quick Workout + each plan day)
// ============================================================
function generateWorkout(params, dayFocus) {
  const { goal, duration, difficulty, equipment } = params;
  const maxDiff = DIFF_RANK[difficulty];
  const promptBias = params.promptBias || parseGoalPrompt(params.goalPrompt || "");

  let pool = EXERCISES.filter(ex =>
    equipment.has(ex.equipment) && DIFF_RANK[ex.difficulty] <= maxDiff
  );
  if (pool.length === 0) pool = EXERCISES.filter(ex => equipment.has(ex.equipment));

  // Each day in a plan is a different *workout type* (strength/cardio/fat loss/mobility) —
  // never a muscle-group split — so dayFocus.dayGoal overrides the overall plan goal for the day.
  const effectiveGoal = dayFocus ? dayFocus.dayGoal : goal;

  const typeWeights = goalTypeWeights(effectiveGoal, promptBias);
  const atGym = isGymSession(params) && effectiveGoal !== "mobility";
  const isCircuit = effectiveGoal === "fatloss" || effectiveGoal === "cardio";
  const gymScale = isCircuit ? 0.5 : 1;

  function score(ex) {
    let s = (typeWeights[ex.type] ?? 1) + gymEquipmentBias(ex, atGym) * gymScale
      + muscleSplitBias(ex, dayFocus && dayFocus.muscleGroup, isCircuit ? 0 : 8);
    // nudge exercises toward any specific muscle groups called out in the prompt
    // (e.g. "focus on back" boosts back/pull exercises without filtering everything else out)
    if (promptBias.muscleFocus.length && ex.muscles) {
      const hit = ex.muscles.some(m => promptBias.muscleFocus.some(f => m.includes(f) || f.includes(m)));
      if (hit) s += 2.5;
    }
    s += Math.random() * 2;
    return s;
  }

  const ranked = [...pool].sort((a, b) => score(b) - score(a));

  const warmupTime = Math.max(3, Math.round(duration * 0.1));
  const cooldownTime = Math.max(3, Math.round(duration * 0.1));
  const mainTime = duration - warmupTime - cooldownTime;

  const exPerBlock = duration <= 15 ? 4 : duration <= 30 ? 6 : duration <= 45 ? 8 : 10;
  const rounds = effectiveGoal === "mobility" ? 1 : duration <= 20 ? 2 : 3;

  const mainPool = ranked.filter(ex => ex.type !== "mobility");
  const warmupPool = EXERCISES.filter(ex =>
    (ex.type === "mobility" || ex.type === "cardio") && equipment.has(ex.equipment)
  );
  const cooldownPool = EXERCISES.filter(ex => ex.type === "mobility" && equipment.has(ex.equipment));

  const mainExCount = Math.min(exPerBlock, mainPool.length || 1);
  const splitGroup = dayFocus && dayFocus.muscleGroup;
  const mainExercises = effectiveGoal === "mobility"
    ? pickUnique(ranked, mainExCount)
    : (isCircuit && splitGroup)
      ? splitCircuitPicks(mainPool, splitGroup, mainExCount)
      : pickUnique(mainPool.length ? mainPool : ranked, mainExCount);

  const perExerciseSeconds = mainExercises.length
    ? Math.max(20, Math.floor((mainTime * 60) / (mainExercises.length * rounds)))
    : 30;

  const blocks = [];

  const warmupPicks = pickUnique([...warmupPool].sort(() => Math.random() - 0.5), 2);
  if (warmupPicks.length && effectiveGoal !== "mobility") {
    blocks.push({
      section: "Warm-up",
      items: warmupPicks.map(ex => ({ ...ex, durationLabel: `${Math.max(20, Math.round(warmupTime * 60 / warmupPicks.length))}s`, _seconds: Math.max(20, Math.round(warmupTime * 60 / warmupPicks.length)), _role: "warmup", _focus: null }))
    });
  }

  if (rounds > 1 && effectiveGoal !== "mobility") {
    blocks.push({
      section: `Main (${rounds} rounds)`,
      items: mainExercises.map(ex => ({ ...ex, durationLabel: formatSetLabel(ex, perExerciseSeconds, promptBias.repStyle), _seconds: perExerciseSeconds, _role: "main", _focus: null }))
    });
  } else {
    blocks.push({
      section: effectiveGoal === "mobility" ? "Routine" : "Main",
      items: mainExercises.map(ex => ({ ...ex, durationLabel: formatSetLabel(ex, perExerciseSeconds, promptBias.repStyle), _seconds: perExerciseSeconds, _role: "main", _focus: null }))
    });
  }

  const cooldownPicks = pickUnique([...cooldownPool].sort(() => Math.random() - 0.5), effectiveGoal === "mobility" ? 0 : 2);
  if (cooldownPicks.length) {
    blocks.push({
      section: "Cool-down",
      items: cooldownPicks.map(ex => ({ ...ex, durationLabel: `${Math.max(20, Math.round(cooldownTime * 60 / cooldownPicks.length))}s`, _seconds: Math.max(20, Math.round(cooldownTime * 60 / cooldownPicks.length)), _role: "cooldown", _focus: null }))
    });
  }

  return {
    goal: effectiveGoal, duration, difficulty,
    equipment: [...equipment],
    createdAt: new Date().toISOString(),
    dayLabel: dayFocus ? dayFocus.label : null,
    blocks
  };
}

// ============================================================
// MULTI-WEEK PLAN GENERATOR
// ============================================================
function generatePlan(params) {
  const { weeks, daysPerWeek } = params;
  const promptBias = params.promptBias || parseGoalPrompt(params.goalPrompt || "");
  const template = getSplitTemplate(daysPerWeek, promptBias);

  const planWeeks = [];
  for (let w = 0; w < weeks; w++) {
    // mild progressive overload: later weeks nudge duration up slightly (capped)
    const progressFactor = 1 + w * 0.08;
    const days = template.map((dayFocus) => {
      if (dayFocus.isRest) {
        return { focus: dayFocus.label, isRest: true, blocks: [] };
      }
      const dayDuration = Math.min(90, Math.round(params.duration * progressFactor));
      const dayParams = { ...params, duration: dayDuration, promptBias };
      const workout = generateWorkout(dayParams, dayFocus);
      return { focus: dayFocus.label, isRest: false, blocks: workout.blocks, duration: dayDuration };
    });
    planWeeks.push({ weekIndex: w, days });
  }

  return {
    goal: params.goal,
    difficulty: params.difficulty,
    equipment: [...params.equipment],
    goalPrompt: params.goalPrompt || "",
    weeksCount: weeks,
    daysPerWeek,
    createdAt: new Date().toISOString(),
    weeks: planWeeks
  };
}

// ============================================================
// SWAP LOGIC — replace one exercise with another hitting the same muscles
// ============================================================
function findSwapCandidate(current, equipmentSet, maxDiff, excludeNames) {
  let candidates = EXERCISES.filter(ex =>
    equipmentSet.has(ex.equipment) &&
    DIFF_RANK[ex.difficulty] <= maxDiff &&
    ex.name !== current.name &&
    !excludeNames.has(ex.name) &&
    ex.muscles.some(m => current.muscles.includes(m))
  );
  if (!candidates.length) {
    candidates = EXERCISES.filter(ex =>
      equipmentSet.has(ex.equipment) &&
      DIFF_RANK[ex.difficulty] <= maxDiff &&
      ex.name !== current.name &&
      !excludeNames.has(ex.name) &&
      ex.type === current.type
    );
  }
  if (!candidates.length) return null;
  if (isGymSession({ equipment: equipmentSet })) {
    const best = Math.max(...candidates.map(ex => gymEquipmentBias(ex, true)));
    candidates = candidates.filter(ex => gymEquipmentBias(ex, true) >= Math.min(best, 0));
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ============================================================
// MUSCLE BODY DIAGRAM — small front/back figure with worked muscles highlighted
// (used for exercise thumbnails + muscle tiles; reused by the Recovery map)
// ============================================================
const BODY_REGIONS = {
  front: [
    ["shoulders", '<ellipse cx="31" cy="47" rx="8.5" ry="7"/><ellipse cx="69" cy="47" rx="8.5" ry="7"/>'],
    ["chest", '<path d="M38 43h11v19c-5 1-9 0-12-3l-1-9c0-4 0-6 2-7z"/><path d="M62 43H51v19c5 1 9 0 12-3l1-9c0-4 0-6-2-7z"/>'],
    ["biceps", '<ellipse cx="25" cy="65" rx="5.2" ry="11"/><ellipse cx="75" cy="65" rx="5.2" ry="11"/>'],
    ["forearms", '<ellipse cx="21" cy="89" rx="4.3" ry="12"/><ellipse cx="79" cy="89" rx="4.3" ry="12"/>'],
    ["core", '<rect x="42" y="64" width="16" height="34" rx="5"/>'],
    ["obliques", '<rect x="35.5" y="65" width="5.5" height="29" rx="2.7"/><rect x="59" y="65" width="5.5" height="29" rx="2.7"/>'],
    ["hip flexors", '<path d="M36 97l7 4-2 9-6-6z"/><path d="M64 97l-7 4 2 9 6-6z"/>'],
    ["quads", '<ellipse cx="41" cy="129" rx="7.5" ry="20"/><ellipse cx="59" cy="129" rx="7.5" ry="20"/>'],
    ["inner thighs", '<ellipse cx="47.6" cy="122" rx="2.2" ry="12"/><ellipse cx="52.4" cy="122" rx="2.2" ry="12"/>'],
    ["calves", '<ellipse cx="41" cy="171" rx="5" ry="15"/><ellipse cx="59" cy="171" rx="5" ry="15"/>']
  ],
  back: [
    ["shoulders", '<ellipse cx="31" cy="47" rx="8.5" ry="7"/><ellipse cx="69" cy="47" rx="8.5" ry="7"/>'],
    ["back", '<path d="M38 41h24l2 14-5 25H41l-5-25z"/>'],
    ["lower back", '<rect x="42" y="81" width="16" height="16" rx="4"/>'],
    ["triceps", '<ellipse cx="25" cy="65" rx="5.2" ry="11"/><ellipse cx="75" cy="65" rx="5.2" ry="11"/>'],
    ["forearms", '<ellipse cx="21" cy="89" rx="4.3" ry="12"/><ellipse cx="79" cy="89" rx="4.3" ry="12"/>'],
    ["glutes", '<ellipse cx="43" cy="107" rx="8" ry="8.5"/><ellipse cx="57" cy="107" rx="8" ry="8.5"/>'],
    ["hamstrings", '<ellipse cx="42" cy="135" rx="7" ry="17"/><ellipse cx="58" cy="135" rx="7" ry="17"/>'],
    ["calves", '<ellipse cx="42" cy="171" rx="5.5" ry="15"/><ellipse cx="58" cy="171" rx="5.5" ry="15"/>']
  ]
};
// exercise-data muscle names -> diagram regions
const MUSCLE_ALIASES = { spine: ["lower back"], hips: ["glutes", "hip flexors"] };
const BACK_VIEW_MUSCLES = new Set(["back", "lower back", "triceps", "glutes", "hamstrings"]);
const ALL_BODY_MUSCLES = [...new Set([...BODY_REGIONS.front, ...BODY_REGIONS.back].map(r => r[0]))];
const UPPER_BODY_MUSCLES = new Set(["shoulders", "chest", "biceps", "triceps", "forearms", "core", "obliques", "back", "lower back"]);
// zoom thumbnails onto the half of the body being worked (Fitbod-style close-ups)
const BODY_VIEWBOX = { full: "0 0 100 192", upper: "6 28 88 84", lower: "16 90 68 102" };

function bodyCropFor(regions) {
  if (!regions.size || regions.size >= ALL_BODY_MUSCLES.length) return "full";
  const list = [...regions];
  if (list.every(r => UPPER_BODY_MUSCLES.has(r))) return "upper";
  if (list.every(r => !UPPER_BODY_MUSCLES.has(r))) return "lower";
  return "full";
}

function bodyRegionsFor(muscles) {
  const out = new Set();
  (muscles || []).forEach(m => {
    if (m === "full body" || m === "cardio") ALL_BODY_MUSCLES.forEach(x => out.add(x));
    else (MUSCLE_ALIASES[m] || [m]).forEach(x => out.add(x));
  });
  return out;
}

function bodyViewFor(regions) {
  let back = 0, front = 0;
  regions.forEach(r => { if (BACK_VIEW_MUSCLES.has(r)) back++; else if (r !== "shoulders" && r !== "forearms" && r !== "calves") front++; });
  return back > front ? "back" : "front";
}

// levels: optional { muscle: 0..1 } to shade by intensity instead of on/off
function bodySvg(muscles, opts = {}) {
  const regions = bodyRegionsFor(muscles);
  const view = opts.view || bodyViewFor(regions);
  const parts = BODY_REGIONS[view].map(([name, shapes]) => {
    const level = opts.levels ? opts.levels[name] : (regions.has(name) ? 1 : 0);
    const style = level > 0 ? ` style="opacity:${(0.35 + 0.65 * level).toFixed(2)}"` : "";
    return `<g class="bm ${level > 0 ? "bm-on" : ""}" data-muscle="${name}"${style}>${shapes}</g>`;
  }).join("");
  const crop = opts.crop === false ? "full" : bodyCropFor(regions);
  return `<svg class="body-svg${opts.className ? " " + opts.className : ""}" viewBox="${BODY_VIEWBOX[crop]}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <g class="bm-base"><circle cx="50" cy="17" r="10.5"/><rect x="45" y="27" width="10" height="9" rx="3"/>
    <path d="M36 38h28c6 0 9 3 9 8l-2 54H29l-2-54c0-5 3-8 9-8z"/>
    <circle cx="19" cy="104" r="4"/><circle cx="81" cy="104" r="4"/><ellipse cx="41" cy="188" rx="5.5" ry="3"/><ellipse cx="59" cy="188" rx="5.5" ry="3"/></g>
    ${parts}</svg>`;
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// top muscles worked (main exercises first), e.g. ["back", "biceps", "glutes"]
function workoutTopMuscles(blocks, n = 4) {
  const main = blocks.filter(b => !/warm|cool/i.test(b.section)).flatMap(b => b.items);
  const items = main.length ? main : blocks.flatMap(b => b.items);
  const counts = {};
  items.forEach(ex => (ex.muscles || []).forEach(m => { if (m !== "cardio") counts[m] = (counts[m] || 0) + 1; }));
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([m, c]) => ({ muscle: m, count: c }));
}

// ============================================================
// WORKOUT HISTORY + MUSCLE RECOVERY
// ============================================================
const HISTORY_KEY = "workoutHistory";
// how hard each exercise type taxes the muscles it lists (stretches don't count)
const TYPE_FATIGUE = { strength: 1, core: 0.8, cardio: 0.5, mobility: 0 };
const SETS_FOR_FULL_FATIGUE = 6;     // ~6 hard sets on a muscle = fully fatigued
const MIN_RECOVERY_HOURS = 36;       // light session
const MAX_RECOVERY_HOURS = 72;       // heavy session
const FRESH_THRESHOLD = 90;          // % at or above which a muscle counts as "fresh"

function getWorkoutHistory() {
  return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
}
function setWorkoutHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

function loggedSets(ex) {
  return ex._log ? ex._log.sets.filter(s => s.done).map(s => ({ reps: s.reps, weight: s.weight })) : [];
}

// Save (or update) a finished session. `target` is the workout/plan-day object holding blocks.
function recordWorkout(target, meta) {
  const exercises = target.blocks.flatMap(b => b.items)
    .map(ex => ({ name: ex.name, type: ex.type, muscles: ex.muscles, sets: loggedSets(ex) }))
    .filter(ex => ex.sets.length);
  if (!exercises.length) return null;
  const history = getWorkoutHistory();
  const existing = target._historyId ? history.findIndex(h => h.id === target._historyId) : -1;
  const entry = {
    id: target._historyId || `w${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    finishedAt: existing >= 0 ? history[existing].finishedAt : new Date().toISOString(),
    title: meta.title,
    goal: meta.goal,
    duration: meta.duration,
    exercises
  };
  if (existing >= 0) history[existing] = entry; else history.unshift(entry);
  setWorkoutHistory(history);
  target._historyId = entry.id;
  return entry;
}

// per-region load (in "sets") for one history entry; first listed muscle is primary, the rest count half
function workoutMuscleLoad(entry) {
  const load = {};
  entry.exercises.forEach(ex => {
    const typeFactor = TYPE_FATIGUE[ex.type] ?? 1;
    if (!typeFactor) return;
    (ex.muscles || []).forEach((m, i) => {
      const broad = m === "full body" || m === "cardio";
      const w = typeFactor * (i === 0 ? 1 : 0.5) * (broad ? 0.4 : 1);
      bodyRegionsFor([m]).forEach(r => { load[r] = (load[r] || 0) + ex.sets.length * w; });
    });
  });
  return load;
}

// returns { fatigue: {region: 0..1}, fresh: {region: 0..100}, lastTrained: {region: ms} }
function computeRecovery(history = getWorkoutHistory(), now = Date.now()) {
  const fatigue = {}, lastTrained = {};
  history.forEach(entry => {
    const t = new Date(entry.finishedAt).getTime();
    const hours = (now - t) / 3.6e6;
    if (hours < 0) return;
    Object.entries(workoutMuscleLoad(entry)).forEach(([r, sets]) => {
      if (sets <= 0) return;
      lastTrained[r] = Math.max(lastTrained[r] || 0, t);
      const impact = Math.min(1, sets / SETS_FOR_FULL_FATIGUE);
      const recoveryHours = MIN_RECOVERY_HOURS + (MAX_RECOVERY_HOURS - MIN_RECOVERY_HOURS) * impact;
      const remaining = impact * Math.max(0, 1 - hours / recoveryHours);
      if (remaining > 0) fatigue[r] = Math.min(1, (fatigue[r] || 0) + remaining);
    });
  });
  const fresh = {};
  ALL_BODY_MUSCLES.forEach(r => { fresh[r] = Math.round(100 * (1 - (fatigue[r] || 0))); });
  return { fatigue, fresh, lastTrained };
}

// freshness of an exercise-data muscle name (aliases like "hips" use their least-recovered region)
function muscleFreshPct(muscle, recovery) {
  const regions = [...bodyRegionsFor([muscle])];
  return regions.length ? Math.min(...regions.map(r => recovery.fresh[r] ?? 100)) : 100;
}

function daysSinceLastWorkout(history = getWorkoutHistory(), now = Date.now()) {
  if (!history.length) return null;
  const last = Math.max(...history.map(h => new Date(h.finishedAt).getTime()));
  return Math.max(0, Math.floor((now - last) / 864e5));
}

// calendar days, so last night's workout reads "yesterday" even if it was under 24 h ago
function relativeDays(ms, now = Date.now()) {
  const startOfDay = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const d = Math.round((startOfDay(now) - startOfDay(ms)) / 864e5);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

// ============================================================
// RENDERING — quick workout
// ============================================================
function renderWorkout(workout) {
  currentWorkout = workout;
  const titleMap = { strength: "Strength", cardio: "Cardio", fatloss: "Fat Loss", mobility: "Mobility", general: "General Fitness" };
  const top = workoutTopMuscles(workout.blocks);
  const allItems = workout.blocks.flatMap(b => b.items);

  if (workout.custom) workout.duration = customWorkoutMinutes(allItems);
  document.getElementById("wo-plan-pill-text").textContent = workout.custom
    ? `Custom · ~${workout.duration} min` : `${titleMap[workout.goal]} · ${workout.duration} min`;
  document.getElementById("workout-title").textContent = workout.custom ? workout.name
    : top.length ? top.map(t => titleCase(t.muscle)).join(", ") : titleMap[workout.goal];
  document.getElementById("workout-sub").textContent = workout.custom
    ? (allItems.length ? `${allItems.length} exercise${allItems.length === 1 ? "" : "s"} · your own workout` : "Add exercises to build your workout")
    : `${allItems.length} exercises · ${titleCase(workout.difficulty)}`;
  document.getElementById("regen-btn").hidden = !!workout.custom;

  const musclesEl = document.getElementById("workout-muscles");
  const recovery = computeRecovery();
  musclesEl.innerHTML = top.map(t => `
    <div class="wo-muscle-tile">
      <div class="wo-muscle-figure">${bodySvg([t.muscle])}</div>
      <span class="wo-muscle-badge" title="Recovery">${muscleFreshPct(t.muscle, recovery)}%</span>
      <span class="wo-muscle-name">${titleCase(t.muscle)}</span>
    </div>`).join("");

  const list = document.getElementById("workout-list");
  list.innerHTML = "";
  renderBlocksInto(list, workout.blocks, lastParams, () => renderWorkout(currentWorkout));
  if (workout.custom && !allItems.length) {
    list.innerHTML = `<div class="empty-state custom-empty">Your workout is empty.<br>Tap <strong>Add an exercise</strong> to search the library.</div>`;
  }
  renderCompleteBanner(document.getElementById("wo-complete-banner"), allItems, workout._historyId, "Workout");
  updateStartButton();
  persistSaved(workout);
}

// green "complete" banner for a workout or plan day once every exercise is logged
function renderCompleteBanner(el, items, finished, noun) {
  if (!el) return;
  const done = items.length > 0 && items.every(exerciseIsLogged);
  el.hidden = !done && !finished;
  if (el.hidden) { el.innerHTML = ""; return; }
  el.innerHTML = `<span class="complete-banner-icon">✓</span>
    <span class="complete-banner-text"><strong>${noun} complete!</strong>
    <span>${finished ? "Saved to your workout history." : `Tap Finish ${noun === "Workout" ? "Workout" : noun} to save it to your history.`}</span></span>`;
}

// floating Start Workout button: opens the next exercise that hasn't been logged yet
function updateStartButton() {
  const btn = document.getElementById("wo-start-btn");
  const finishBtn = document.getElementById("finish-btn");
  const items = currentWorkout ? currentWorkout.blocks.flatMap(b => b.items) : [];
  const logged = items.filter(exerciseIsLogged).length;
  const allLogged = items.length > 0 && logged === items.length;
  const finished = !!(currentWorkout && currentWorkout._historyId);
  btn.hidden = !items.length || (allLogged && finished);
  document.getElementById("wo-start-text").textContent =
    allLogged ? "Finish Workout" : logged ? "Next Exercise" : "Start Workout";
  finishBtn.hidden = !logged;
  finishBtn.textContent = finished ? "Update Workout History" : "Finish Workout";
}

function finishCurrentWorkout() {
  if (!currentWorkout) return;
  const titleMap = { strength: "Strength", cardio: "Cardio", fatloss: "Fat Loss", mobility: "Mobility", general: "General Fitness" };
  const muscles = workoutTopMuscles(currentWorkout.blocks, 3).map(t => titleCase(t.muscle)).join(", ");
  const entry = recordWorkout(currentWorkout, {
    title: currentWorkout.custom ? currentWorkout.name : muscles || titleMap[currentWorkout.goal],
    goal: currentWorkout.goal,
    duration: currentWorkout.duration
  });
  if (!entry) return;
  updateStartButton();
  persistSaved(currentWorkout);
  showTab("recovery-screen");
}
document.getElementById("finish-btn").addEventListener("click", finishCurrentWorkout);

document.getElementById("wo-start-btn").addEventListener("click", () => {
  const next = currentWorkout && currentWorkout.blocks.flatMap(b => b.items).find(ex => !exerciseIsLogged(ex));
  if (!next) { finishCurrentWorkout(); return; }
  openExerciseDetail(next, "workout-screen", () => renderWorkout(currentWorkout));
});
document.getElementById("wo-plan-pill").addEventListener("click", () => showTab("setup-screen"));

// ---------- add an exercise (quick workout) ----------
// Exercise library filters (Add an exercise / Build My Own)
const ADDEX_MUSCLE_GROUPS = [
  ["all", "All"], ["chest", "Chest", ["chest"]], ["back", "Back", ["back", "lower back"]], ["shoulders", "Shoulders", ["shoulders"]],
  ["arms", "Arms", ["biceps", "triceps", "forearms"]], ["legs", "Legs", ["quads", "hamstrings", "calves", "inner thighs", "hip flexors"]],
  ["glutes", "Glutes", ["glutes", "hips"]], ["core", "Core", ["core", "obliques"]], ["mobility", "Stretch & Mobility"]
];
const EQUIPMENT_LABELS = { bodyweight: "Bodyweight", dumbbells: "Dumbbells", barbell: "Barbell", machine: "Machines", "cable machine": "Cable",
  bench: "Bench", kettlebell: "Kettlebell", bands: "Bands", "pullup bar": "Pull-up Bar" };
let addexMuscle = "all";
let addexEquip = "all";

function addexMatchesMuscle(ex, key) {
  if (key === "all") return true;
  if (key === "mobility") return ex.type === "mobility";
  const group = ADDEX_MUSCLE_GROUPS.find(g => g[0] === key);
  // upper-body groups go by the main muscle (so push-ups aren't "Arms"); legs/glutes/core also count the second one
  const considered = ["legs", "glutes", "core"].includes(key) ? ex.muscles.slice(0, 2) : ex.muscles.slice(0, 1);
  return ex.type !== "mobility" && considered.some(m => group[2].includes(m));
}

function addExerciseCandidates(query) {
  const custom = !!(currentWorkout && currentWorkout.custom);
  const equipment = lastParams.equipment instanceof Set ? lastParams.equipment : new Set(lastParams.equipment);
  const maxDiff = custom ? 3 : DIFF_RANK[lastParams.difficulty];
  const inWorkout = new Set(currentWorkout.blocks.flatMap(b => b.items).map(i => i.name));
  const q = query.trim().toLowerCase();
  return EXERCISES.filter(ex =>
    equipment.has(ex.equipment) && DIFF_RANK[ex.difficulty] <= maxDiff && (custom || !inWorkout.has(ex.name)) &&
    addexMatchesMuscle(ex, addexMuscle) && (addexEquip === "all" || ex.equipment === addexEquip) &&
    (!q || ex.name.toLowerCase().includes(q) || ex.muscles.some(m => m.includes(q)) || ex.equipment.includes(q))
  ).sort((a, b) => {
    if (custom) return a.name.localeCompare(b.name);
    const atGym = isGymSession(lastParams);
    return (gymEquipmentBias(b, atGym) - gymEquipmentBias(a, atGym)) || a.name.localeCompare(b.name);
  });
}

function renderAddExerciseFilters() {
  const equipment = lastParams.equipment instanceof Set ? lastParams.equipment : new Set(lastParams.equipment);
  const chip = (attr, key, label, on) =>
    `<button type="button" class="chip${on ? " selected" : ""}" data-${attr}="${key}">${label}</button>`;
  document.getElementById("addex-muscle-filters").innerHTML =
    ADDEX_MUSCLE_GROUPS.map(([key, label]) => chip("addex-muscle", key, label, addexMuscle === key)).join("");
  const equips = ALL_EQUIPMENT.filter(e => equipment.has(e));
  document.getElementById("addex-equip-filters").innerHTML = chip("addex-equip", "all", "All equipment", addexEquip === "all") +
    equips.map(e => chip("addex-equip", e, EQUIPMENT_LABELS[e] || titleCase(e), addexEquip === e)).join("");
}

function renderAddExerciseList() {
  const custom = !!(currentWorkout && currentWorkout.custom);
  const listEl = document.getElementById("addex-list");
  const results = addExerciseCandidates(document.getElementById("addex-search").value);
  const inWorkout = new Set(currentWorkout.blocks.flatMap(b => b.items).map(i => i.name));
  renderAddExerciseFilters();
  document.getElementById("addex-count").textContent = `${results.length} exercise${results.length === 1 ? "" : "s"}`;
  const doneBtn = document.getElementById("addex-done-btn");
  doneBtn.hidden = !custom;
  doneBtn.textContent = inWorkout.size ? `Done · ${inWorkout.size} exercise${inWorkout.size === 1 ? "" : "s"}` : "Done";
  if (!results.length) {
    listEl.innerHTML = `<div class="empty-state">No matching exercises.<br>Try another search or filter.</div>`;
    return;
  }
  listEl.innerHTML = "";
  results.forEach(ex => {
    const added = custom && inWorkout.has(ex.name);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "addex-item" + (added ? " added" : "");
    btn.innerHTML = `<span class="ex-thumb">${bodySvg(ex.muscles)}</span>
      <span class="addex-text"><span class="addex-name">${ex.name}</span><span class="addex-meta">${ex.muscles.map(titleCase).join(", ")} · ${EQUIPMENT_LABELS[ex.equipment] || ex.equipment}${custom ? ` · ${titleCase(ex.difficulty)}` : ""}</span></span>
      <span class="addex-plus" aria-hidden="true">${added ? "✓" : "+"}</span>`;
    btn.setAttribute("aria-label", `${added ? "Remove" : "Add"} ${ex.name}`);
    btn.addEventListener("click", () => {
      if (added) removeExerciseFromWorkout(ex.name);
      else addExerciseToWorkout(ex);
    });
    listEl.appendChild(btn);
  });
}

function removeExerciseFromWorkout(name) {
  currentWorkout.blocks.forEach(b => { b.items = b.items.filter(i => i.name !== name); });
  renderWorkout(currentWorkout);
  if (!document.getElementById("addex-modal").hidden) renderAddExerciseList();
}

// rough session length for a custom workout: ~2.25 min per strength set (work + rest), ~1.2 min per timed set
function customWorkoutMinutes(items) {
  const mins = items.reduce((sum, ex) => {
    const sets = ex._log ? ex._log.sets.length : 3;
    return sum + sets * (ex.type === "strength" ? 2.25 : 1.2);
  }, 0);
  return Math.max(5, Math.round(mins / 5) * 5);
}

function startCustomWorkout() {
  const name = (document.getElementById("custom-name").value || "").trim() || "My Workout";
  lastParams = { goal: "custom", duration: 0, difficulty: "advanced", equipment: new Set(ALL_EQUIPMENT), muscles: new Set(), custom: true };
  const workout = { goal: "custom", custom: true, name, duration: 0, difficulty: "advanced", equipment: [...ALL_EQUIPMENT],
                    createdAt: new Date().toISOString(), dayLabel: null, blocks: [{ section: "Exercises", items: [] }] };
  renderWorkout(workout);
  showTab("workout-screen");
  openAddExercise();
}

function openAddExercise() {
  if (!currentWorkout) return;
  addexMuscle = "all";
  addexEquip = "all";
  document.getElementById("addex-search").value = "";
  renderAddExerciseList();
  document.getElementById("addex-modal").hidden = false;
}

function addExerciseToWorkout(ex) {
  const blocks = currentWorkout.blocks;
  const target = blocks.find(b => !/warm|cool/i.test(b.section)) || blocks[blocks.length - 1];
  const sample = target.items.find(i => i._seconds) || {};
  const seconds = sample._seconds || 40;
  const repStyle = currentWorkout.custom ? "hypertrophy" : (lastParams.promptBias || parseGoalPrompt(lastParams.goalPrompt || "")).repStyle;
  target.items.push({ ...ex, durationLabel: formatSetLabel(ex, seconds, repStyle), _seconds: seconds, _role: "main", _focus: null });
  renderWorkout(currentWorkout);
  // building your own: keep the library open so several exercises can be picked in one go
  if (currentWorkout.custom) renderAddExerciseList();
  else document.getElementById("addex-modal").hidden = true;
}

document.getElementById("wo-add-exercise").addEventListener("click", openAddExercise);
document.getElementById("addex-search").addEventListener("input", renderAddExerciseList);
document.getElementById("addex-done-btn").addEventListener("click", () => { document.getElementById("addex-modal").hidden = true; });
["addex-muscle-filters", "addex-equip-filters"].forEach(id => document.getElementById(id).addEventListener("click", e => {
  const c = e.target.closest("[data-addex-muscle], [data-addex-equip]");
  if (!c) return;
  if (c.dataset.addexMuscle) addexMuscle = c.dataset.addexMuscle;
  if (c.dataset.addexEquip) addexEquip = c.dataset.addexEquip;
  renderAddExerciseList();
}));
document.getElementById("addex-close-btn").addEventListener("click", () => {
  document.getElementById("addex-modal").hidden = true;
});

function renderBlocksInto(container, blocks, params, onChange) {
  let counter = 1;
  const equipmentSet = params.equipment instanceof Set ? params.equipment : new Set(params.equipment);
  const maxDiff = DIFF_RANK[params.difficulty];

  blocks.forEach(block => {
    const h = document.createElement("div");
    h.className = "wo-block";
    h.innerHTML = `<div class="wo-section">${block.section}</div>`;
    block.items.forEach((ex, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "exercise-card-wrap";

      const row = document.createElement("div");
      const logged = exerciseIsLogged(ex);
      const complete = exerciseIsComplete(ex);
      row.className = "exercise-card" + (logged ? " logged" : "") + (complete ? " complete" : logged ? " partial" : "");
      row.innerHTML = `
        <div class="ex-thumb">${bodySvg(ex.muscles)}</div>
        <div class="info">
          <div class="name">${ex.name}</div>
          <div class="ex-muscle-sub">${(ex.muscles || []).slice(0, 2).map(titleCase).join(" · ")}</div>
          <div class="meta">${exercisePlanSummary(ex)}</div>
          ${logged ? `<div class="log-badge">${exerciseSetSummary(ex)}</div>` : ""}
        </div>
        <div class="ex-side">
          <span class="ex-check${complete ? " done" : logged ? " partial" : ""}" aria-label="${complete ? "Complete" : logged ? "Partly done" : "Not logged yet"}">✓</span>
          <button type="button" class="swap-btn" title="Swap exercise" aria-label="Swap ${ex.name}">⇄</button>
          ${params.custom ? `<span class="custom-tools">${idx > 0 ? `<button type="button" class="move-btn" title="Move up" aria-label="Move ${ex.name} up">↑</button>` : ""}<button type="button" class="remove-btn" title="Remove" aria-label="Remove ${ex.name}">✕</button></span>` : ""}
        </div>
      `;
      counter++;
      row.querySelector(".swap-btn").addEventListener("click", e => {
        e.stopPropagation();
        const excludeNames = new Set(block.items.map(i => i.name));
        const alt = findSwapCandidate(ex, equipmentSet, maxDiff, excludeNames);
        if (!alt) return;
        block.items[idx] = { ...alt, durationLabel: formatSetLabel(alt, ex._seconds || 30), _seconds: ex._seconds, _role: ex._role, _focus: ex._focus };
        onChange();
      });

      const removeBtn = row.querySelector(".remove-btn");
      if (removeBtn) removeBtn.addEventListener("click", e => { e.stopPropagation(); block.items.splice(idx, 1); onChange(); });
      const moveBtn = row.querySelector(".move-btn");
      if (moveBtn) moveBtn.addEventListener("click", e => {
        e.stopPropagation();
        [block.items[idx - 1], block.items[idx]] = [block.items[idx], block.items[idx - 1]];
        onChange();
      });

      row.addEventListener("click", () => {
        const screen = container.closest(".screen");
        openExerciseDetail(ex, screen ? screen.id : "workout-screen", onChange);
      });

      wrap.appendChild(row);
      h.appendChild(wrap);
    });
    container.appendChild(h);
  });
}

// ---------- per-exercise set logging ----------
function exerciseIsLogged(ex) {
  return !!(ex._log && ex._log.sets && ex._log.sets.some(s => s.done));
}
// every set ticked (vs. only some)
function exerciseIsComplete(ex) {
  return exerciseIsLogged(ex) && ex._log.sets.every(s => s.done);
}
// e.g. "3 sets • 10-12 reps" (strength) or "45s • Dumbbells" (timed)
function exercisePlanSummary(ex) {
  const sets = ex._log ? ex._log.sets.length : defaultLog().sets.length;
  return ex.type === "strength"
    ? `${sets} sets • ${ex.durationLabel}`
    : `${ex.durationLabel} • ${titleCase(ex.equipment)}`;
}
// e.g. "3/3 sets • Reps 10/10/8 • 30 kg" from what was actually logged
function exerciseSetSummary(ex) {
  const done = ex._log.sets.filter(s => s.done);
  const parts = [`${done.length}/${ex._log.sets.length} sets`];
  const reps = done.map(s => parseFloat(s.reps) || 0);
  const weights = done.map(s => parseFloat(s.weight)).filter(n => n > 0);
  if (reps.some(n => n > 0)) parts.push(`Reps ${reps.join("/")}`);
  if (weights.length) parts.push(`${Math.max(...weights)} kg`);
  return parts.join(" • ");
}
function defaultLog() {
  return { sets: [{ reps: "", weight: "", done: false }, { reps: "", weight: "", done: false }, { reps: "", weight: "", done: false }], note: "", restSeconds: 90 };
}

// ============================================================
// EXERCISE PAGE — full screen: body hero, muscles, History | Log tabs
// ============================================================
let exDetail = null; // { ex, returnTo, onDone, scrollY, tab, log }
let restInterval = null;

function stopRestTimer() {
  if (restInterval) { clearInterval(restInterval); restInterval = null; }
}

// every past session (newest first) that included this exercise
function exerciseHistory(name, history = getWorkoutHistory()) {
  return history
    .map(h => ({ finishedAt: h.finishedAt, title: h.title, id: h.id, ex: h.exercises.find(e => e.name === name) }))
    .filter(h => h.ex && h.ex.sets.length)
    .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
}

// new log pre-filled with what you lifted last time (sets unticked), so logging is mostly tapping ✓
function prefilledLog(ex) {
  const log = defaultLog();
  const last = exerciseHistory(ex.name)[0];
  if (last) {
    log.sets = last.ex.sets.map(st => ({ reps: String(st.reps ?? ""), weight: String(st.weight ?? ""), done: false }));
    while (log.sets.length < 3) log.sets.push({ reps: "", weight: "", done: false });
  }
  return log;
}

// Each .screen is its own scroll area (the page itself never scrolls, so the
// tab bar stays put), so scroll resets target the active screen.
function activeScreenEl() { return document.querySelector(".screen.active"); }
function screenScrollY() { const s = activeScreenEl(); return s ? s.scrollTop : 0; }
function scrollScreenTo(y) { const s = activeScreenEl(); if (s) s.scrollTop = y; }

function openExerciseDetail(ex, returnTo, onDone) {
  stopRestTimer();
  exDetail = {
    ex, returnTo, onDone,
    scrollY: screenScrollY(),
    tab: "log",
    log: ex._log ? JSON.parse(JSON.stringify(ex._log)) : prefilledLog(ex)
  };
  renderExerciseDetail();
  showTab("exercise-screen");
  scrollScreenTo(0);
}

function closeExerciseDetail(save) {
  const d = exDetail;
  if (!d) return;
  stopRestTimer();
  if (save) {
    d.ex._log = d.log;
    d.ex._done = d.log.sets.some(st => st.done);
  }
  exDetail = null;
  showTab(d.returnTo);
  if (d.onDone) d.onDone();
  scrollScreenTo(d.scrollY);
}

function renderExerciseDetail() {
  const { ex, tab } = exDetail;
  document.getElementById("exd-title").textContent = ex.name;
  document.getElementById("exd-hero").innerHTML = `
    <div class="exd-figures">
      ${bodySvg(ex.muscles, { view: "front", crop: false, className: "exd-svg" })}
      ${bodySvg(ex.muscles, { view: "back", crop: false, className: "exd-svg" })}
    </div>
    <div class="exd-hero-chips">
      ${ex.durationLabel ? `<span class="exd-chip">${exercisePlanSummary(ex)}</span>` : ""}
      <span class="exd-chip type">${titleCase(ex.type || "")}</span>
    </div>`;
  document.getElementById("exd-muscles").innerHTML =
    `<strong>Muscles:</strong> ${(ex.muscles || []).map(titleCase).join(", ")}<span class="exd-equip"> · ${titleCase(ex.equipment || "")}</span>`;
  document.querySelectorAll(".exd-tab").forEach(b => {
    const on = b.dataset.exdTab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  const body = document.getElementById("exd-body");
  body.innerHTML = "";
  if (tab === "history") renderExerciseHistoryTab(body);
  else renderExerciseLogTab(body);
}

function renderExerciseHistoryTab(body) {
  const sessions = exerciseHistory(exDetail.ex.name);
  if (!sessions.length) {
    body.innerHTML = `<div class="empty-state">No history yet. Finish a workout with this exercise and your sets will show here.</div>`;
    return;
  }
  const best = sessions.flatMap(h => h.ex.sets).reduce((b, st) => {
    const wgt = parseFloat(st.weight) || 0, reps = parseFloat(st.reps) || 0;
    return (wgt > b.weight || (wgt === b.weight && reps > b.reps)) ? { weight: wgt, reps } : b;
  }, { weight: 0, reps: 0 });
  const bestHtml = best.weight || best.reps
    ? `<div class="exd-best">Best set: <strong>${best.weight ? best.weight + " kg × " : ""}${best.reps} reps</strong></div>` : "";
  body.innerHTML = bestHtml + sessions.map(h => {
    const when = new Date(h.finishedAt);
    return `
      <div class="exd-hist-card">
        <div class="exd-hist-head"><span class="exd-hist-date">${when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span><span class="exd-hist-rel">${relativeDays(when.getTime())}</span></div>
        ${h.ex.sets.map((st, i) => `<div class="exd-hist-set"><span class="set-num">${i + 1}</span><span>${st.reps || 0} reps</span><span>${parseFloat(st.weight) ? st.weight + " kg" : "Bodyweight"}</span></div>`).join("")}
      </div>`;
  }).join("");
}

function renderExerciseLogTab(body) {
  const log = exDetail.log;
  const restLabel = `Rest for ${Math.round(log.restSeconds / 60) || 1} min`;
  body.innerHTML = `
    <div class="exd-complete" hidden>
      <div class="exd-complete-box"><span class="exd-tick">✓</span> All sets completed</div>
      <button type="button" class="exd-restart-btn">Restart</button>
    </div>
    <div class="rest-banner">
      <div class="rest-text"><strong class="rest-time-display">${restLabel}</strong><span>Rest between each set</span></div>
      <button type="button" class="rest-play-btn" aria-label="Start rest timer">▶</button>
    </div>
    <div class="set-grid">
      <div class="set-grid-header"><span></span><span>Reps</span><span>Weight (kg)</span><span></span></div>
      <div class="set-rows"></div>
    </div>
    <button type="button" class="add-set-btn">+ Add New Set</button>
    <textarea class="note-input" placeholder="Add your note here…"></textarea>
    <div class="exd-status"></div>
    <div class="log-actions">
      <button type="button" class="primary-btn log-save-btn">Save Changes</button>
      <button type="button" class="primary-btn secondary log-cancel-btn">Cancel</button>
    </div>
  `;
  const note = body.querySelector(".note-input");
  note.value = log.note || "";
  note.addEventListener("input", () => { log.note = note.value; });

  const rowsEl = body.querySelector(".set-rows");
  function refreshStatus() {
    const done = log.sets.filter(st => st.done).length;
    const all = log.sets.length > 0 && done === log.sets.length;
    body.querySelector(".exd-complete").hidden = !all;
    body.querySelector(".exd-status").textContent = all ? "You have marked all sets."
      : done ? `${done} of ${log.sets.length} sets marked.` : "Tap ✓ on each set as you finish it.";
  }
  function renderSetRows() {
    rowsEl.innerHTML = "";
    log.sets.forEach((st, i) => {
      const r = document.createElement("div");
      r.className = "set-row" + (st.done ? " done" : "");
      r.innerHTML = `
        <span class="set-num">${i + 1}</span>
        <input type="number" inputmode="numeric" class="set-reps" placeholder="0" value="${st.reps}">
        <input type="number" inputmode="decimal" class="set-weight" placeholder="0" value="${st.weight}">
        <button type="button" class="set-check${st.done ? " done" : ""}" aria-label="Mark set ${i + 1} complete">✓</button>
      `;
      // typing only updates the model, no re-render, so the iPhone keyboard stays open
      r.querySelector(".set-reps").addEventListener("input", e => { st.reps = e.target.value; });
      r.querySelector(".set-weight").addEventListener("input", e => { st.weight = e.target.value; });
      r.querySelector(".set-check").addEventListener("click", () => {
        st.done = !st.done;
        renderSetRows();
      });
      rowsEl.appendChild(r);
    });
    refreshStatus();
  }
  renderSetRows();

  body.querySelector(".add-set-btn").addEventListener("click", () => {
    const prev = log.sets[log.sets.length - 1];
    log.sets.push({ reps: prev ? prev.reps : "", weight: prev ? prev.weight : "", done: false });
    renderSetRows();
  });
  body.querySelector(".exd-restart-btn").addEventListener("click", () => {
    log.sets.forEach(st => { st.done = false; });
    renderSetRows();
  });

  body.querySelector(".rest-play-btn").addEventListener("click", e => {
    const btn = e.currentTarget;
    const display = body.querySelector(".rest-time-display");
    stopRestTimer();
    let remaining = log.restSeconds;
    btn.disabled = true;
    restInterval = setInterval(() => {
      remaining -= 1;
      display.textContent = `Rest: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
      if (remaining <= 0) {
        stopRestTimer();
        display.textContent = restLabel;
        btn.disabled = false;
      }
    }, 1000);
  });

  body.querySelector(".log-save-btn").addEventListener("click", () => closeExerciseDetail(true));
  body.querySelector(".log-cancel-btn").addEventListener("click", () => closeExerciseDetail(false));
}

document.getElementById("exd-back-btn").addEventListener("click", () => closeExerciseDetail(false));
document.querySelectorAll(".exd-tab").forEach(b => b.addEventListener("click", () => {
  if (!exDetail || exDetail.tab === b.dataset.exdTab) return;
  stopRestTimer();
  exDetail.tab = b.dataset.exdTab;
  renderExerciseDetail();
}));

// ---------- save quick workout ----------
document.getElementById("save-btn").addEventListener("click", () => {
  if (!currentWorkout) return;
  saveEntry("workout", currentWorkout);
  const btn = document.getElementById("save-btn");
  btn.textContent = "Saved ✓";
  setTimeout(() => { btn.textContent = "Save Workout"; }, 1500);
});

// ============================================================
// RENDERING — multi-week plan
// ============================================================
function renderPlan(plan) {
  const titleMap = { strength: "Strength", cardio: "Cardio", fatloss: "Fat Loss", mobility: "Mobility", general: "General Fitness" };
  document.getElementById("plan-title").textContent =
    `${titleMap[plan.goal]} · ${plan.daysPerWeek}x/wk · ${plan.weeksCount}wk`;

  const tabsEl = document.getElementById("plan-week-tabs");
  tabsEl.innerHTML = "";
  plan.weeks.forEach((wk, i) => {
    const btn = document.createElement("button");
    btn.className = "week-tab" + (i === activeWeekIndex ? " active" : "") + (weekIsDone(wk) ? " done" : "");
    btn.innerHTML = `${weekIsDone(wk) ? '<span class="pill-check">✓</span>' : ""}Week ${i + 1}`;
    btn.addEventListener("click", () => {
      activeWeekIndex = i;
      activePlanDayIndex = null;
      renderPlan(plan);
    });
    tabsEl.appendChild(btn);
  });

  const week = plan.weeks[activeWeekIndex];
  if (activePlanDayIndex === null || activePlanDayIndex >= week.days.length) activePlanDayIndex = firstOpenDayIndex(week);

  const pillsEl = document.getElementById("plan-day-pills");
  pillsEl.innerHTML = "";
  week.days.forEach((day, dayIdx) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "day-pill" + (dayIdx === activePlanDayIndex ? " active" : "") + (day.isRest ? " rest" : "") + (planDayIsDone(day) ? " done" : "");
    pill.innerHTML = `${planDayIsDone(day) ? '<span class="pill-check">✓</span>' : ""}Day ${dayIdx + 1}`;
    pill.addEventListener("click", () => {
      activePlanDayIndex = dayIdx;
      renderPlan(plan);
    });
    pillsEl.appendChild(pill);
  });
  const activePill = pillsEl.children[activePlanDayIndex];
  if (activePill && activePill.scrollIntoView) activePill.scrollIntoView({ block: "nearest", inline: "center" });

  const dayListEl = document.getElementById("plan-day-list");
  dayListEl.innerHTML = "";
  const dayIdx = activePlanDayIndex;
  const day = week.days[dayIdx];
  const dayName = `Day ${dayIdx + 1}`;
  if (day.isRest) {
    dayListEl.innerHTML = `
      <div class="day-card rest">
        <div><div class="day-name">${dayName} · Rest Day</div><div class="day-focus">Recover today and come back stronger.</div></div>
        <div class="rest-icon">🌙</div>
      </div>`;
    persistSaved(plan);
    return;
  }
  const allExercises = day.blocks.flatMap(b => b.items);
  const loggedCount = allExercises.filter(exerciseIsLogged).length;
  const head = document.createElement("div");
  head.className = "plan-day-head";
  head.innerHTML = `
    <div class="plan-day-title">${day.focus}</div>
    <div class="plan-day-sub">${allExercises.length} Exercises · ${day.duration} min${loggedCount ? ` · ${loggedCount}/${allExercises.length} logged` : ""}</div>`;
  dayListEl.appendChild(head);
  const banner = document.createElement("div");
  banner.className = "complete-banner";
  renderCompleteBanner(banner, allExercises, day._historyId, dayName);
  if (!banner.hidden) dayListEl.appendChild(banner);

  const exContainer = document.createElement("div");
  exContainer.className = "day-exercises";
  dayListEl.appendChild(exContainer);
  const planParamsForDay = { ...lastParams, duration: day.duration };
  renderBlocksInto(exContainer, day.blocks, planParamsForDay, () => renderPlan(plan));

  if (loggedCount) {
    const finishDay = document.createElement("button");
    finishDay.type = "button";
    finishDay.className = "primary-btn finish-day-btn";
    finishDay.textContent = day._historyId ? "Update Workout History" : `Finish ${dayName}`;
    finishDay.addEventListener("click", () => {
      const entry = recordWorkout(day, {
        title: `Week ${activeWeekIndex + 1} · ${dayName} · ${day.focus}`,
        goal: plan.goal,
        duration: day.duration
      });
      if (entry) { persistSaved(plan); showTab("recovery-screen"); }
    });
    dayListEl.appendChild(finishDay);
  }
  persistSaved(plan);
}

// a plan day counts as done once it's been finished, or every exercise in it is logged
function planDayIsDone(day) {
  if (day.isRest) return false;
  const items = day.blocks.flatMap(b => b.items);
  return !!day._historyId || (items.length > 0 && items.every(exerciseIsLogged));
}
function weekIsDone(week) {
  const trainingDays = week.days.filter(d => !d.isRest);
  return trainingDays.length > 0 && trainingDays.every(planDayIsDone);
}
function firstOpenDayIndex(week) {
  const i = week.days.findIndex(d => !d.isRest && !planDayIsDone(d));
  return i >= 0 ? i : 0;
}

document.getElementById("save-plan-btn").addEventListener("click", () => {
  if (!currentPlan) return;
  saveEntry("plan", currentPlan);
  const btn = document.getElementById("save-plan-btn");
  btn.textContent = "Saved ✓";
  setTimeout(() => { btn.textContent = "Save Plan"; }, 1500);
});

// ============================================================
// SAVED WORKOUTS — storage, progress, and opening a saved item
// ============================================================
const SAVED_KEY = "savedWorkouts";
const GOAL_TITLES = { strength: "Strength", cardio: "Cardio", fatloss: "Fat Loss", mobility: "Mobility", general: "General Fitness" };

// every saved entry gets a stable id so logged progress can be written back to it
function getSavedEntries() {
  const list = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  let changed = false;
  list.forEach(e => {
    if (!e.id) { e.id = `s${Date.now()}${Math.random().toString(36).slice(2, 7)}`; changed = true; }
    if (e.data && e.data._savedId !== e.id) { e.data._savedId = e.id; changed = true; }
  });
  if (changed) setSavedEntries(list);
  return list;
}
function setSavedEntries(list) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

// Save (or re-save) a workout/plan. Returns the entry id.
function saveEntry(kind, data) {
  const list = getSavedEntries();
  const i = data._savedId ? list.findIndex(e => e.id === data._savedId) : -1;
  if (i >= 0) { list[i].data = data; setSavedEntries(list); return data._savedId; }
  const id = `s${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  data._savedId = id;
  list.unshift({ id, kind, data, savedAt: new Date().toISOString() });
  setSavedEntries(list);
  return id;
}

// keep a saved workout/plan's ticks in sync after every change (so progress survives closing the app)
function persistSaved(data) {
  if (!data || !data._savedId) return;
  const list = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  const i = list.findIndex(e => e.id === data._savedId);
  if (i < 0) { delete data._savedId; return; }
  list[i].data = data;
  setSavedEntries(list);
}

function savedEntryTitle(entry) {
  const w = entry.data;
  return entry.kind === "plan"
    ? `${GOAL_TITLES[w.goal] || "Workout"} Plan · ${w.daysPerWeek}x/wk · ${w.weeksCount}wk`
    : w.custom ? `${w.name} · ~${w.duration} min` : `${GOAL_TITLES[w.goal] || "Workout"} · ${w.duration} min`;
}

// { done, total, complete, text } for a saved workout or plan
function savedEntryProgress(entry) {
  const w = entry.data;
  if (entry.kind === "plan") {
    const days = w.weeks.flatMap(wk => wk.days).filter(d => !d.isRest);
    const done = days.filter(planDayIsDone).length;
    const complete = days.length > 0 && done === days.length;
    return { done, total: days.length, complete, text: complete ? "Plan complete" : `${done}/${days.length} days done` };
  }
  const items = w.blocks.flatMap(b => b.items);
  const done = items.filter(exerciseIsLogged).length;
  const complete = !!w._historyId || (items.length > 0 && done === items.length);
  return { done, total: items.length, complete, text: complete ? "Completed" : done ? `${done}/${items.length} exercises logged` : `${items.length} exercises` };
}

function openSavedEntry(entry) {
  const w = entry.data;
  w._savedId = entry.id;
  if (entry.kind === "plan") {
    currentPlan = w;
    activeWeekIndex = Math.max(0, w.weeks.findIndex(wk => !weekIsDone(wk)));
    activePlanDayIndex = null;
    lastParams = { goal: w.goal, difficulty: w.difficulty, equipment: new Set(w.equipment), muscles: new Set() };
    renderPlan(w);
    showTab("plan-screen");
  } else {
    lastParams = { goal: w.goal, duration: w.duration, difficulty: w.difficulty, equipment: new Set(w.equipment), muscles: new Set(), custom: !!w.custom };
    renderWorkout(w);
    showTab("workout-screen");
  }
}

function renderHomeSaved() {
  const list = getSavedEntries();
  const sub = document.getElementById("home-saved-sub");
  if (sub) sub.textContent = list.length
    ? `${list.length} saved · tap to see all`
    : "Save a workout or plan to find it here";
  const el = document.getElementById("home-saved-list");
  if (!el) return;
  el.innerHTML = "";
  list.slice(0, 3).forEach(entry => {
    const prog = savedEntryProgress(entry);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "home-saved-item" + (prog.complete ? " complete" : "");
    btn.innerHTML = `
      <span class="home-saved-kind">${entry.kind === "plan" ? "Plan" : "Workout"}</span>
      <span class="home-saved-text"><span class="home-saved-title">${savedEntryTitle(entry)}</span><span class="home-saved-prog">${prog.complete ? "✓ " : ""}${prog.text} · ${new Date(entry.data.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span></span>
      <span class="dash-card-arrow" aria-hidden="true">›</span>`;
    btn.addEventListener("click", () => openSavedEntry(entry));
    el.appendChild(btn);
  });
}

// ============================================================
// RECOVERY SCREEN
// ============================================================
// where each region's % badge sits on the big figure (viewBox units 0-100 x 0-192)
const RECOVERY_BADGE_ANCHORS = {
  front: { shoulders: [69, 45], chest: [43, 52], biceps: [24, 66], forearms: [80, 90], core: [50, 74], obliques: [63, 90],
           "hip flexors": [37, 104], quads: [41, 130], "inner thighs": [55, 124], calves: [59, 171] },
  back: { shoulders: [31, 45], back: [50, 58], "lower back": [50, 89], triceps: [76, 66], forearms: [20, 90],
          glutes: [57, 107], hamstrings: [42, 137], calves: [58, 171] }
};

function recoveryFigureHtml(view, recovery) {
  const badges = Object.entries(RECOVERY_BADGE_ANCHORS[view])
    .filter(([r]) => recovery.fresh[r] < 100)
    .map(([r, [x, y]]) => `<span class="rec-badge" style="left:${x}%;top:${(y / 192) * 100}%">${recovery.fresh[r]}%</span>`)
    .join("");
  return `<div class="rec-figure-wrap">
    <div class="rec-figure">${bodySvg([], { view, crop: false, levels: recovery.fatigue, className: "rec-svg" })}${badges}</div>
    <div class="rec-figure-label">${view === "front" ? "Front" : "Back"}</div>
  </div>`;
}

function renderRecovery() {
  const history = getWorkoutHistory();
  const recovery = computeRecovery(history);
  const days = daysSinceLastWorkout(history);
  const freshCount = ALL_BODY_MUSCLES.filter(r => recovery.fresh[r] >= FRESH_THRESHOLD).length;

  document.getElementById("rec-days").textContent = days === null ? "–" : days;
  document.getElementById("rec-days-label").textContent = days === 1 ? "Day since your last workout" : "Days since your last workout";
  document.getElementById("rec-fresh").textContent = freshCount;
  document.getElementById("rec-fresh-label").textContent = freshCount === 1 ? "Fresh muscle group" : "Fresh muscle groups";
  document.getElementById("rec-figures").innerHTML = recoveryFigureHtml("front", recovery) + recoveryFigureHtml("back", recovery);

  const trained = ALL_BODY_MUSCLES.filter(r => recovery.lastTrained[r] && Date.now() - recovery.lastTrained[r] < 7 * 864e5)
    .sort((a, b) => recovery.fresh[a] - recovery.fresh[b]);
  const musclesEl = document.getElementById("rec-muscle-list");
  musclesEl.innerHTML = trained.length ? trained.map(r => {
    const pct = recovery.fresh[r];
    const state = pct >= FRESH_THRESHOLD ? "fresh" : pct >= 60 ? "recovering" : "sore";
    return `<div class="rec-muscle-row">
      <div class="rec-muscle-top"><span class="rec-muscle-name">${titleCase(r)}</span><span class="rec-muscle-pct ${state}">${pct}%</span></div>
      <div class="rec-bar"><div class="rec-bar-fill ${state}" style="width:${pct}%"></div></div>
      <div class="rec-muscle-sub">Trained ${relativeDays(recovery.lastTrained[r])}</div>
    </div>`;
  }).join("") : `<div class="empty-state">All muscles are fresh.<br>Finish a workout to start tracking recovery.</div>`;

  const histEl = document.getElementById("rec-history-list");
  if (!history.length) {
    histEl.innerHTML = `<div class="empty-state">No workouts finished yet.<br>Log your sets, then tap Finish Workout.</div>`;
    return;
  }
  histEl.innerHTML = "";
  history.slice(0, 20).forEach(h => {
    const sets = h.exercises.reduce((n, ex) => n + ex.sets.length, 0);
    const cardioSub = h.cardio ? `${h.cardio.minutes} min cardio · ~${h.cardio.kcal} kcal${h.cardio.distanceKm ? ` · ${h.cardio.distanceKm} km` : ""}` : null;
    const volume = h.exercises.reduce((v, ex) => v + ex.sets.reduce((a, s) => a + (parseFloat(s.reps) || 0) * (parseFloat(s.weight) || 0), 0), 0);
    const item = document.createElement("div");
    item.className = "saved-item rec-history-item";
    item.innerHTML = `
      <div>
        <div class="title">${h.title}</div>
        <div class="sub">${new Date(h.finishedAt).toLocaleDateString()} · ${cardioSub || `${h.exercises.length} exercises · ${sets} sets${volume ? ` · ${Math.round(volume).toLocaleString()} kg` : ""}`}</div>
      </div>
      <button type="button" class="saved-delete-btn" aria-label="Delete workout">Delete</button>`;
    item.querySelector("button").addEventListener("click", () => {
      if (!confirm("Delete this workout from your history?")) return;
      setWorkoutHistory(getWorkoutHistory().filter(x => x.id !== h.id));
      renderRecovery();
    });
    histEl.appendChild(item);
  });
}

// ============================================================
// SAVED LIST — two folders: workouts & plans / meals
// ============================================================
let savedFolder = null; // null = folder overview, "workouts" | "meals" = inside a folder
const SAVED_FOLDER_TITLES = { workouts: "Workouts & Plans", meals: "Meals" };

function savedCountText(n, emptyText) {
  return n ? `${n} saved` : emptyText;
}

function renderSaved() {
  const saved = getSavedEntries();
  const meals = qaGetSavedMeals();
  const doneCount = saved.filter(e => savedEntryProgress(e).complete).length;
  document.getElementById("saved-folder-workouts-sub").textContent =
    savedCountText(saved.length, "No workouts saved yet") + (doneCount ? ` · ${doneCount} complete` : "");
  document.getElementById("saved-folder-meals-sub").textContent = savedCountText(meals.length, "No meals saved yet");

  const inFolder = savedFolder in SAVED_FOLDER_TITLES;
  document.getElementById("saved-folders").hidden = inFolder;
  document.getElementById("saved-folder-view").hidden = !inFolder;
  document.getElementById("saved-folder-title").textContent = inFolder ? SAVED_FOLDER_TITLES[savedFolder] : "";
  document.getElementById("saved-list").hidden = savedFolder !== "workouts";
  document.getElementById("saved-meals-list").hidden = savedFolder !== "meals";

  if (savedFolder === "workouts") renderSavedWorkouts(saved);
  if (savedFolder === "meals") renderSavedMeals();
}

document.querySelectorAll(".saved-folder").forEach(btn => {
  btn.addEventListener("click", () => { savedFolder = btn.dataset.folder; renderSaved(); scrollScreenTo(0); });
});
document.getElementById("saved-folder-back").addEventListener("click", () => { savedFolder = null; renderSaved(); });

function renderSavedWorkouts(saved) {
  const list = document.getElementById("saved-list");
  list.innerHTML = "";
  if (!saved.length) {
    list.innerHTML = `<div class="empty-state">Nothing saved yet.<br>Build a workout or plan in the Build tab.</div>`;
    return;
  }
  saved.forEach(entry => {
    const w = entry.data;
    const prog = savedEntryProgress(entry);
    const item = document.createElement("div");
    item.className = "saved-item" + (prog.complete ? " complete" : "");
    item.innerHTML = `
      <div>
        <div class="title">${savedEntryTitle(entry)}</div>
        <div class="sub">${new Date(w.createdAt).toLocaleDateString()} · ${w.difficulty} · <span class="saved-prog">${prog.complete ? "✓ " : ""}${prog.text}</span></div>
      </div>
      <button type="button">Delete</button>
    `;
    item.querySelector("div").addEventListener("click", () => openSavedEntry(entry));
    item.querySelector("button").addEventListener("click", e => {
      e.stopPropagation();
      setSavedEntries(getSavedEntries().filter(x => x.id !== entry.id));
      if (w === currentPlan || w === currentWorkout) delete w._savedId;
      renderSaved();
    });
    list.appendChild(item);
  });
}

function renderSavedMeals() {
  const mealsListEl = document.getElementById("saved-meals-list");
  if (!mealsListEl) return;
  const meals = qaGetSavedMeals();
  mealsListEl.innerHTML = "";
  if (!meals.length) {
    mealsListEl.innerHTML = `<div class="empty-state">No saved meals yet.<br>Use Quick Add Ingredient on the Food tab.</div>`;
    return;
  }
  meals.forEach((meal, i) => {
    const item = document.createElement("div");
    item.className = "saved-item";
    const date = new Date(meal.createdAt);
    item.innerHTML = `
      <div>
        <div class="title">${meal.name}</div>
        <div class="sub">${date.toLocaleDateString()} · ${Math.round(meal.perServing.calories)} kcal/serving · ${meal.servings.toFixed(2)} servings</div>
      </div>
      <div class="saved-actions">
        <button type="button" class="saved-edit-btn">Edit</button>
        <button type="button" class="saved-delete-btn">Delete</button>
      </div>
    `;
    item.querySelector(".saved-edit-btn").addEventListener("click", e => {
      e.stopPropagation();
      qaOpenEditModal(i);
    });
    item.querySelector("div").addEventListener("click", () => {
      addFoodEntry({
        name: meal.name,
        brand: "",
        image: "",
        serving: "1 serving",
        calories: meal.perServing.calories,
        protein: meal.perServing.protein,
        carbs: meal.perServing.carbs,
        fat: meal.perServing.fat
      });
      updateHomeStats();
      showTab("nutrition-screen");
    });
    item.querySelector(".saved-delete-btn").addEventListener("click", e => {
      e.stopPropagation();
      const arr = qaGetSavedMeals();
      arr.splice(i, 1);
      qaSetSavedMeals(arr);
      renderSavedMeals();
    });
    mealsListEl.appendChild(item);
  });
}

// register service worker for offline/home-screen use.
// Also force an immediate reload once a newly installed worker takes control,
// so the phone never gets stuck showing an old cached build.
if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then(reg => {
      reg.update().catch(() => {});
    }).catch(() => {});
  });
}

// ============================================================
// HOME SCREEN
// ============================================================
function updateHomeStats() {
  const savedWorkouts = getSavedEntries();
  const todayLog = getFoodLogFor(todayKey());
  const totals = sumNutrients(todayLog);
  const targets = getNutritionTargets();
  const calEl = document.getElementById("stat-calories");
  const woEl = document.getElementById("stat-workouts");
  if (calEl) calEl.textContent = Math.round(totals.calories);
  if (woEl) woEl.textContent = savedWorkouts.length;

  const greetingEl = document.getElementById("hero-greeting");
  if (greetingEl) {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    greetingEl.textContent = greeting;
  }

  const calSubEl = document.getElementById("home-cal-sub");
  const homeBeerAdj = beerDiaryAdjustment(todayKey());
  if (calSubEl) calSubEl.textContent = `${Math.round(totals.calories)} / ${targets.calories + (homeBeerAdj ? homeBeerAdj.delta : 0)} kcal today`;
  const beerSubEl = document.getElementById("home-beer-sub");
  if (beerSubEl) {
    const bs = beerPlanStats();
    beerSubEl.textContent = bs.beers ? `${bs.beers} beer${bs.beers === 1 ? "" : "s"} planned this week · ~${bs.kcal.toLocaleString()} kcal` : "Plan the week's beers and balance the calories";
  }
  renderHomeSaved();

  const recSubEl = document.getElementById("home-recovery-sub");
  if (recSubEl) {
    const history = getWorkoutHistory();
    const recovery = computeRecovery(history);
    const fresh = ALL_BODY_MUSCLES.filter(r => recovery.fresh[r] >= FRESH_THRESHOLD).length;
    const days = daysSinceLastWorkout(history);
    recSubEl.textContent = days === null
      ? "Finish a workout to track recovery"
      : `${fresh} fresh muscle groups · last workout ${days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago"}`;
  }

  const cardioSubEl = document.getElementById("home-cardio-sub");
  if (cardioSubEl) {
    const wk = cardioWeekStats();
    cardioSubEl.textContent = wk.sessions ? `${wk.minutes} / ${CARDIO_WEEKLY_TARGET_MIN} min this week · ~${wk.kcal} kcal` : "Runs, rides, rows & HIIT, tailored to you";
  }

  setMiniRing("protein", totals.protein, targets.protein);
  setMiniRing("carbs", totals.carbs, targets.carbs);
  setMiniRing("fat", totals.fat, targets.fat);
}

function setMiniRing(key, value, target) {
  const ring = document.getElementById(`home-ring-${key}`);
  const text = document.getElementById(`home-ring-${key}-text`);
  if (!ring) return;
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  ring.style.setProperty("--pct", pct);
  if (text) text.textContent = `${Math.round(value)}g`;
}

document.querySelectorAll(".action-tile, .dash-card, .action-tile-mini").forEach(tile => {
  tile.addEventListener("click", () => {
    const goto = tile.dataset.goto;
    if (goto === "saved-screen") savedFolder = tile.dataset.folder || null;
    if (tile.dataset.presetmode && goto === "setup-screen") {
      applySetupMode(tile.dataset.presetmode);
    }
    if (tile.dataset.openscan) {
      showTab(goto);
      openScanner();
    } else {
      showTab(goto);
    }
  });
});

// override showTab to also refresh home stats + update topbar title
const titleByScreen = {
  "home-screen": "Workout App",
  "setup-screen": "Build",
  "workout-screen": "Your Workout",
  "plan-screen": "Your Plan",
  "nutrition-screen": "Nutrition",
  "saved-screen": "Saved",
  "recovery-screen": "Recovery",
  "exercise-screen": "Exercise",
  "recipes-screen": "Recipes",
  "mealplan-screen": "Meal Plan",
  "cardio-screen": "Cardio",
  "beer-screen": "Beer Planner"
};
const _origShowTab = showTab;
showTab = function (id) {
  _origShowTab(id);
  const titleEl = document.getElementById("topbar-title");
  if (titleEl && titleByScreen[id]) titleEl.textContent = titleByScreen[id];
  document.querySelector(".topbar").hidden = id === "workout-screen" || id === "exercise-screen";
  if (id !== "exercise-screen" && exDetail) { stopRestTimer(); exDetail = null; }
  if (id === "home-screen") updateHomeStats();
  if (id === "nutrition-screen") renderFoodLog();
  if (id === "recovery-screen") renderRecovery();
  if (id === "recipes-screen") renderRecipes();
  if (id === "mealplan-screen") renderMealPlan();
  if (id === "cardio-screen") renderCardio();
  if (id === "beer-screen") renderBeerPlanner();
  // sync bottom tabbar highlight for screens not directly in tabbar (workout/plan detail views)
  const tabMap = { "setup-screen": "setup-screen", "workout-screen": "setup-screen", "plan-screen": "setup-screen", "exercise-screen": "setup-screen", "recipes-screen": "nutrition-screen", "mealplan-screen": "nutrition-screen", "cardio-screen": "home-screen", "beer-screen": "nutrition-screen" };
  const activeTabId = tabMap[id] || id;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === activeTabId));
};

// ============================================================
// NUTRITION — date-aware food log storage
// ============================================================
let activeFoodDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, defaults to today

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function getFoodLogAll() {
  return JSON.parse(localStorage.getItem("foodLog") || "{}");
}

function getFoodLogFor(key) {
  const all = getFoodLogAll();
  return all[key] || [];
}

function getTodayFoodLog() {
  return getFoodLogFor(activeFoodDate);
}

function saveFoodLogFor(key, entries) {
  const all = getFoodLogAll();
  all[key] = entries;
  localStorage.setItem("foodLog", JSON.stringify(all));
}

function saveTodayFoodLog(entries) {
  saveFoodLogFor(activeFoodDate, entries);
}

// ---------- nutrition targets (calories + macros, goal-aware) ----------
const DEFAULT_TARGETS = { calories: 2000, protein: 150, carbs: 200, fat: 65, goalType: "maintain" };

function getNutritionTargets() {
  try {
    const stored = JSON.parse(localStorage.getItem("nutritionTargets"));
    if (stored && stored.calories) return stored;
  } catch (e) {}
  return { ...DEFAULT_TARGETS };
}

function setNutritionTargets(targets) {
  localStorage.setItem("nutritionTargets", JSON.stringify(targets));
}

// backward-compat shim: some code paths may still ask for just the calorie number
function getCalorieGoal() {
  return getNutritionTargets().calories;
}

// Daily calorie change per goal pace (≈7,700 kcal per kg of body weight)
const GOAL_PACES = {
  lose: [["gentle", -250, "Gentle", "≈0.25 kg/week"], ["steady", -500, "Steady", "≈0.5 kg/week"], ["fast", -750, "Fast", "≈0.75 kg/week"]],
  gain: [["lean", 200, "Lean", "≈0.2 kg/week, least fat"], ["steady", 300, "Steady", "≈0.3 kg/week"], ["fast", 500, "Faster", "≈0.5 kg/week"]]
};
const ACTIVITY_LABELS = { "1.2": "Sedentary", "1.375": "Lightly Active", "1.55": "Moderately Active", "1.725": "Active", "1.9": "Very Active" };

function goalAdjustment(goalType, pace) {
  const list = GOAL_PACES[goalType];
  if (!list) return 0;
  const found = list.find(p => p[0] === pace) || list[1];
  return found[1];
}

// Mifflin-St Jeor BMR -> TDEE -> goal-adjusted calories -> macro split
function calculateTargets({ sex, age, weightKg, heightCm, activityFactor, goalType, pace }) {
  const bmr = sex === "female"
    ? 10 * weightKg + 6.25 * heightCm - 5 * age - 161
    : 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  const tdee = bmr * activityFactor;

  let calories = tdee;
  let proteinPerKg = 1.8;
  let fatPct = 0.25;

  if (goalType === "lose") {
    calories = tdee + goalAdjustment("lose", pace);
    proteinPerKg = 2.0; // higher protein to preserve muscle in a deficit
    fatPct = 0.25;
  } else if (goalType === "gain") {
    calories = tdee + goalAdjustment("gain", pace);
    proteinPerKg = 1.8;
    fatPct = 0.22;
  } else {
    calories = tdee;
    proteinPerKg = 1.6;
    fatPct = 0.27;
  }
  calories = Math.max(1200, Math.round(calories));

  const protein = Math.round(weightKg * proteinPerKg);
  const fat = Math.round((calories * fatPct) / 9);
  const proteinCals = protein * 4;
  const fatCals = fat * 9;
  const carbs = Math.max(0, Math.round((calories - proteinCals - fatCals) / 4));

  return { calories, protein, carbs, fat, goalType, bmr: Math.round(bmr), tdee: Math.round(tdee) };
}

function sumNutrients(entries) {
  return entries.reduce((acc, e) => {
    acc.calories += e.calories || 0;
    acc.protein += e.protein || 0;
    acc.carbs += e.carbs || 0;
    acc.fat += e.fat || 0;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

function renderDateStrip() {
  const stripEl = document.getElementById("date-strip");
  stripEl.innerHTML = "";
  const all = getFoodLogAll();
  const today = new Date();
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // show last 13 days + today (14 total), oldest first so "today" sits at the right edge
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d);
  }

  days.forEach(d => {
    const key = dateKey(d);
    const isToday = key === todayKey();
    const hasEntries = (all[key] || []).length > 0;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "date-chip" + (key === activeFoodDate ? " selected" : "") + (hasEntries ? " has-entries" : "");
    chip.setAttribute("role", "tab");
    chip.setAttribute("aria-selected", key === activeFoodDate ? "true" : "false");
    chip.innerHTML = `
      <span class="dow">${isToday ? "Today" : dowNames[d.getDay()]}</span>
      <span class="dom">${d.getDate()}</span>
      <span class="dot"></span>
    `;
    chip.addEventListener("click", () => {
      activeFoodDate = key;
      renderFoodLog();
    });
    stripEl.appendChild(chip);
  });

  // auto-scroll to the end (today) on first render
  requestAnimationFrame(() => { stripEl.scrollLeft = stripEl.scrollWidth; });
}

function renderFoodLog() {
  renderDateStrip();

  const entries = getTodayFoodLog();
  const totals = sumNutrients(entries);
  const targets = { ...getNutritionTargets() };
  const beerAdj = beerDiaryAdjustment(activeFoodDate);
  if (beerAdj) targets.calories += beerAdj.delta;
  const beerNote = document.getElementById("beer-adj-note");
  if (beerNote) { beerNote.hidden = !beerAdj; beerNote.textContent = beerAdjNoteText(beerAdj); }

  document.getElementById("n-cal").textContent = Math.round(totals.calories);
  document.getElementById("n-cal-goal").textContent = targets.calories;

  const pct = targets.calories > 0 ? Math.min(100, (totals.calories / targets.calories) * 100) : 0;
  const fillEl = document.getElementById("cal-progress-fill");
  fillEl.style.width = pct + "%";
  fillEl.classList.toggle("over", totals.calories > targets.calories);

  const goalLabels = { lose: "Lose Fat", maintain: "Maintain", gain: "Build Muscle" };
  const badgeEl = document.getElementById("goal-type-badge");
  if (badgeEl) badgeEl.textContent = goalLabels[targets.goalType] || "Maintain";

  function setMacroRing(key, value, target) {
    const pctVal = target > 0 ? Math.min(100, (value / target) * 100) : 0;
    const ringEl = document.getElementById(`ring-${key}`);
    if (ringEl) ringEl.style.setProperty("--pct", pctVal);
    document.getElementById(`n-${key}-text`).textContent = `${Math.round(value)}/${target}g`;
  }
  setMacroRing("protein", totals.protein, targets.protein);
  setMacroRing("carbs", totals.carbs, targets.carbs);
  setMacroRing("fat", totals.fat, targets.fat);

  const isToday = activeFoodDate === todayKey();
  const dateLabel = isToday ? "Today" : new Date(activeFoodDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  document.getElementById("day-totals-heading").textContent = `${dateLabel}'s Totals`;
  document.getElementById("food-log-heading").textContent = `Logged ${isToday ? "Today" : "on " + dateLabel}`;

  const listEl = document.getElementById("food-log-list");
  listEl.innerHTML = "";
  if (!entries.length) {
    listEl.innerHTML = `<div class="empty-state">No food logged ${isToday ? "today" : "this day"}.${isToday ? "<br>Scan a barcode to get started." : ""}</div>`;
    return;
  }
  entries.forEach((e, i) => {
    const card = document.createElement("div");
    card.className = "food-card";
    card.innerHTML = `
      ${e.image ? `<img src="${e.image}" alt="" loading="lazy">` : `<div class="food-card-noimg"></div>`}
      <div class="info">
        <div class="name">${e.name}</div>
        <div class="brand">${e.brand || ""}</div>
        <div class="macros">P ${Math.round(e.protein)}g · C ${Math.round(e.carbs)}g · F ${Math.round(e.fat)}g</div>
      </div>
      <div class="cal">${Math.round(e.calories)}<br><small>kcal</small></div>
      <button class="remove-btn" aria-label="Remove ${e.name}">✕</button>
    `;
    card.querySelector(".remove-btn").addEventListener("click", () => {
      const current = getTodayFoodLog();
      current.splice(i, 1);
      saveTodayFoodLog(current);
      renderFoodLog();
    });
    listEl.appendChild(card);
  });
}

function addFoodEntry(entry) {
  activeFoodDate = todayKey(); // always log new scans to today
  const entries = getTodayFoodLog();
  entries.unshift({ ...entry, loggedAt: new Date().toISOString() });
  saveTodayFoodLog(entries);
  renderFoodLog();
}

// ---------- nutrition goal modal ----------
const goalModalState = { goalmode: "calculate", nutriGoal: "maintain", sex: "male", activity: "1.375", pace: "steady" };

function selectGoalChip(field, value) {
  const group = document.querySelector(`[data-field="${field}"]`);
  if (!group) return;
  group.querySelectorAll(".chip, .mode-btn").forEach(c => {
    const on = c.dataset.value === String(value);
    c.classList.toggle("selected", on);
    c.setAttribute("aria-selected", String(on));
  });
}

function renderGoalPace() {
  const list = GOAL_PACES[goalModalState.nutriGoal];
  const wrap = document.getElementById("goal-pace-wrap");
  wrap.hidden = !list;
  if (!list) return;
  if (!list.some(p => p[0] === goalModalState.pace)) goalModalState.pace = "steady";
  document.getElementById("goal-pace-label").textContent = goalModalState.nutriGoal === "lose" ? "How fast do you want to lose?" : "How fast do you want to gain?";
  document.getElementById("goal-pace").innerHTML = list.map(([key, kcal, label, rate]) =>
    `<button type="button" class="chip pace-opt${goalModalState.pace === key ? " selected" : ""}" data-value="${key}"><span class="ao-title">${label}</span><span class="ao-desc">${kcal > 0 ? "+" : "−"}${Math.abs(kcal)} kcal · ${rate}</span></button>`).join("");
}

document.querySelectorAll('[data-field="goalmode"], [data-field="nutriGoal"], [data-field="sex"], [data-field="activity"], [data-field="pace"]').forEach(group => {
  const field = group.dataset.field;
  group.addEventListener("click", e => {
    const btn = e.target.closest(".chip, .mode-btn");
    if (!btn) return;
    group.querySelectorAll(".chip, .mode-btn").forEach(c => {
      c.classList.remove("selected");
      c.setAttribute("aria-selected", "false");
    });
    btn.classList.add("selected");
    btn.setAttribute("aria-selected", "true");
    goalModalState[field] = btn.dataset.value;

    if (field === "goalmode") {
      const isManual = btn.dataset.value === "manual";
      document.getElementById("goal-calc-fields").hidden = isManual;
      document.getElementById("goal-manual-fields").hidden = !isManual;
    }
    if (field === "nutriGoal") { goalModalState.pace = "steady"; renderGoalPace(); }
    updateGoalPreview();
  });
});

function updateGoalPreview() {
  const previewEl = document.getElementById("goal-preview");
  if (!previewEl || goalModalState.goalmode !== "calculate") return;
  const age = parseFloat(document.getElementById("goal-age").value);
  const weightKg = parseFloat(document.getElementById("goal-weight").value);
  const heightCm = parseFloat(document.getElementById("goal-height").value);
  if (!age || !weightKg || !heightCm) {
    previewEl.innerHTML = "Enter your details above to see your personalised targets.";
    return;
  }
  const t = calculateTargets({
    sex: goalModalState.sex,
    age, weightKg, heightCm,
    activityFactor: parseFloat(goalModalState.activity),
    goalType: goalModalState.nutriGoal,
    pace: goalModalState.pace
  });
  const adj = t.calories - t.tdee;
  const goalName = { lose: "Lose fat", gain: "Build muscle", maintain: "Maintain" }[goalModalState.nutriGoal];
  previewEl.innerHTML = `
    <div class="gp-row"><span>Resting burn (BMR)</span><span>${t.bmr.toLocaleString()} kcal</span></div>
    <div class="gp-row"><span>× ${goalModalState.activity} ${ACTIVITY_LABELS[goalModalState.activity]}</span><span>${t.tdee.toLocaleString()} kcal</span></div>
    <div class="gp-row gp-sub"><span>Maintenance (what you burn a day)</span></div>
    <div class="gp-row"><span>${goalName}</span><span>${adj === 0 ? "±0" : (adj > 0 ? "+" : "−") + Math.abs(adj).toLocaleString()} kcal</span></div>
    <div class="gp-row gp-total"><span>Daily target</span><strong>${t.calories.toLocaleString()} kcal</strong></div>
    <div class="gp-macros">Protein <strong>${t.protein}g</strong> · Carbs <strong>${t.carbs}g</strong> · Fat <strong>${t.fat}g</strong></div>
    ${t.calories === 1200 && t.tdee + adj < 1200 ? `<div class="gp-note">Raised to the 1,200 kcal safe minimum.</div>` : ""}`;
}

["goal-age", "goal-weight", "goal-height"].forEach(id => {
  document.getElementById(id).addEventListener("input", updateGoalPreview);
});

document.getElementById("cal-goal-btn").addEventListener("click", () => {
  const targets = getNutritionTargets();
  document.getElementById("manual-cal").value = targets.calories;
  document.getElementById("manual-protein").value = targets.protein;
  document.getElementById("manual-carbs").value = targets.carbs;
  document.getElementById("manual-fat").value = targets.fat;
  const prof = targets.profile;
  if (prof) {
    Object.assign(goalModalState, { sex: prof.sex, activity: prof.activity, nutriGoal: prof.goal, pace: prof.pace || "steady" });
    document.getElementById("goal-age").value = prof.age;
    document.getElementById("goal-weight").value = prof.weightKg;
    document.getElementById("goal-height").value = prof.heightCm;
  }
  ["sex", "activity", "nutriGoal"].forEach(f => selectGoalChip(f, goalModalState[f]));
  renderGoalPace();
  updateGoalPreview();
  document.getElementById("goal-modal").hidden = false;
});
document.getElementById("goal-cancel-btn").addEventListener("click", () => {
  document.getElementById("goal-modal").hidden = true;
});
document.getElementById("goal-save-btn").addEventListener("click", () => {
  let targets;
  if (goalModalState.goalmode === "manual") {
    targets = {
      calories: parseInt(document.getElementById("manual-cal").value, 10) || DEFAULT_TARGETS.calories,
      protein: parseInt(document.getElementById("manual-protein").value, 10) || DEFAULT_TARGETS.protein,
      carbs: parseInt(document.getElementById("manual-carbs").value, 10) || DEFAULT_TARGETS.carbs,
      fat: parseInt(document.getElementById("manual-fat").value, 10) || DEFAULT_TARGETS.fat,
      goalType: goalModalState.nutriGoal
    };
  } else {
    const age = parseFloat(document.getElementById("goal-age").value);
    const weightKg = parseFloat(document.getElementById("goal-weight").value);
    const heightCm = parseFloat(document.getElementById("goal-height").value);
    if (!age || !weightKg || !heightCm) {
      alert("Please enter age, weight, and height to calculate your targets, or switch to manual entry.");
      return;
    }
    targets = calculateTargets({
      sex: goalModalState.sex,
      age, weightKg, heightCm,
      activityFactor: parseFloat(goalModalState.activity),
      goalType: goalModalState.nutriGoal,
      pace: goalModalState.pace
    });
    targets.profile = { sex: goalModalState.sex, age, weightKg, heightCm, activity: goalModalState.activity,
                        goal: goalModalState.nutriGoal, pace: goalModalState.pace };
  }
  setNutritionTargets(targets);
  document.getElementById("goal-modal").hidden = true;
  renderFoodLog();
});

// ============================================================
// NUTRITION — Open Food Facts lookup
// ============================================================
async function lookupBarcode(code) {
  const resultEl = document.getElementById("scan-result");
  resultEl.innerHTML = `<div class="scan-feedback">Looking up ${code}…</div>`;
  try {
    const resp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`);
    const data = await resp.json();
    if (data.status !== 1 || !data.product) {
      resultEl.innerHTML = `<div class="scan-feedback">No product found for barcode ${code}. Try another or enter manually.</div>`;
      return;
    }
    const p = data.product;
    const n = p.nutriments || {};
    const serving = p.serving_size || "100 g";
    const item = {
      name: p.product_name || p.generic_name || "Unknown product",
      brand: p.brands || "",
      image: p.image_front_small_url || p.image_small_url || "",
      serving,
      calories: n["energy-kcal_serving"] ?? n["energy-kcal_100g"] ?? 0,
      protein: n["proteins_serving"] ?? n["proteins_100g"] ?? 0,
      carbs: n["carbohydrates_serving"] ?? n["carbohydrates_100g"] ?? 0,
      fat: n["fat_serving"] ?? n["fat_100g"] ?? 0,
      barcode: code
    };
    renderScanResult(item);
  } catch (err) {
    resultEl.innerHTML = `<div class="scan-feedback">Couldn't reach the food database. Check your connection and try again.</div>`;
  }
}

function renderScanResult(item) {
  const resultEl = document.getElementById("scan-result");
  resultEl.innerHTML = `
    <div class="scan-result-card">
      <div class="result-name">${item.name}</div>
      ${item.brand ? `<div class="result-brand">${item.brand}</div>` : ""}
      <div class="result-grid">
        <div class="stat"><div class="stat-value">${Math.round(item.calories)}</div><div class="stat-label">kcal</div></div>
        <div class="stat"><div class="stat-value">${Math.round(item.protein)}</div><div class="stat-label">protein g</div></div>
        <div class="stat"><div class="stat-value">${Math.round(item.carbs)}</div><div class="stat-label">carbs g</div></div>
        <div class="stat"><div class="stat-value">${Math.round(item.fat)}</div><div class="stat-label">fat g</div></div>
      </div>
      <div style="font-size:12px;color:#9580c8;margin-bottom:10px;">Per serving: ${item.serving}</div>
      <button type="button" class="primary-btn result-add">Add to Today's Log</button>
    </div>
  `;
  resultEl.querySelector(".result-add").addEventListener("click", () => {
    addFoodEntry(item);
    resultEl.innerHTML = `<div class="scan-feedback">Added ✓</div>`;
    updateHomeStats();
  });
}

document.getElementById("manual-barcode-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("manual-barcode-input");
  const code = input.value.trim();
  if (!code) return;
  lookupBarcode(code);
  input.value = "";
});

// ============================================================
// NUTRITION — camera barcode scanner (ZXing)
// ============================================================
let zxingReader = null;
let scannerStream = null;

function openScanner() {
  const modal = document.getElementById("scanner-modal");
  const statusEl = document.getElementById("scanner-status");
  const video = document.getElementById("scanner-video");
  modal.hidden = false;
  statusEl.textContent = "Requesting camera access…";

  if (typeof ZXing === "undefined") {
    statusEl.textContent = "Scanner library failed to load. Use manual entry instead.";
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusEl.textContent = "Camera isn't available on this browser. Use manual entry below.";
    return;
  }

  // Must call getUserMedia synchronously within the click handler on iOS Safari —
  // any delay (setTimeout, extra await before the first media call) causes a silent denial.
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then(stream => {
      scannerStream = stream;
      video.srcObject = stream;
      video.play().catch(() => {});
      statusEl.textContent = "Point your camera at a barcode";

      zxingReader = new ZXing.BrowserMultiFormatReader();
      zxingReader.decodeFromStream(stream, video, (result, err) => {
        if (result) {
          statusEl.textContent = `Found: ${result.getText()}`;
          closeScanner();
          lookupBarcode(result.getText());
        }
      });
    })
    .catch(err => {
      if (err && err.name === "NotAllowedError") {
        statusEl.textContent = "Camera permission denied. Enable it in Settings → Safari → Camera, or use manual entry below.";
      } else if (err && err.name === "NotFoundError") {
        statusEl.textContent = "No camera found on this device. Use manual entry below.";
      } else {
        statusEl.textContent = "Camera unavailable (" + (err && err.message ? err.message : "unknown error") + "). Use manual entry below.";
      }
    });
}

function closeScanner() {
  const modal = document.getElementById("scanner-modal");
  modal.hidden = true;
  if (zxingReader) {
    try { zxingReader.reset(); } catch (e) {}
    zxingReader = null;
  }
  if (scannerStream) {
    scannerStream.getTracks().forEach(t => t.stop());
    scannerStream = null;
  }
  const video = document.getElementById("scanner-video");
  if (video) video.srcObject = null;
}

document.getElementById("scan-btn").addEventListener("click", openScanner);
document.getElementById("scanner-close-btn").addEventListener("click", closeScanner);


// ============================================================
// QUICK ADD — text search against Open Food Facts + multi-ingredient
// meal builder (search -> ingredient cards -> name & save as meal)
// ============================================================
const UNIT_OPTIONS_BASE = [
  { key: "serving", label: null, grams: null }, // filled in per-product from serving_quantity
  { key: "g", label: "g", grams: 1 },
  { key: "oz", label: "oz (28.3495 g)", grams: 28.3495 }
];

let qaIngredients = []; // [{ id, name, brand, image, baseGramsPer100: {calories,protein,carbs,fat}, servingGrams, qty, unit }]
let qaIngredientSeq = 0;
let qaSearchAbort = null;
let qaUnitPopupTargetId = null;
let qaSavedMeals = []; // loaded lazily

function qaGetSavedMeals() {
  return JSON.parse(localStorage.getItem("savedMeals") || "[]");
}
function qaSetSavedMeals(meals) {
  localStorage.setItem("savedMeals", JSON.stringify(meals));
}

let qaEditingIndex = null; // index into savedMeals while editing, null when creating a new meal

function qaSetModalMode(editing) {
  document.getElementById("qa-title").textContent = editing ? "Edit Meal" : "Quick Add";
  document.getElementById("qa-save-only-btn").textContent = editing ? "Save Changes" : "Save This Meal";
  document.getElementById("qa-log-save-btn").textContent = editing ? "Log and Save Changes" : "Log and Save This Meal";
  document.getElementById("qa-log-only-btn").textContent = editing ? "Log Without Saving Changes" : "Log Without Saving";
}

// ---------- suggested meal name from the ingredients' brand + product names ----------
let qaAutoName = ""; // last name we filled in, so we only overwrite it if the user hasn't typed their own

function qaFirstBrand(brand) {
  return (brand || "").split(",")[0].trim();
}

function qaIngredientLabel(ing) {
  const name = (ing.name || "").trim();
  const brand = qaFirstBrand(ing.brand);
  if (!brand || name.toLowerCase().includes(brand.toLowerCase())) return name || brand;
  return name ? `${brand} ${name}` : brand;
}

function qaSuggestMealName(ings) {
  if (!ings.length) return "";
  if (ings.length === 1) return qaIngredientLabel(ings[0]);
  const names = ings.map(i => (i.name || "").trim()).filter(Boolean);
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} & ${names[2]}`;
  return `${names[0]}, ${names[1]} + ${names.length - 2} more`;
}

function qaApplySuggestedName() {
  const input = document.getElementById("qa-meal-name");
  const current = input.value.trim();
  if (current && current !== qaAutoName) return; // user typed their own name, keep it
  qaAutoName = qaSuggestMealName(qaIngredients);
  input.value = qaAutoName;
}

// Rebuild editable ingredients from a saved meal. Meals saved before editing existed
// only stored name + grams per ingredient, so they load as one combined "original recipe" ingredient.
function qaMealHasFullIngredients(meal) {
  const ings = meal.ingredients || [];
  return ings.length > 0 && ings.every(i => i.per100);
}

function qaIngredientsFromMeal(meal) {
  const ings = meal.ingredients || [];
  if (qaMealHasFullIngredients(meal)) {
    return ings.map(i => ({
      id: ++qaIngredientSeq,
      name: i.name,
      brand: i.brand || "",
      per100: { ...i.per100 },
      servingGrams: i.servingGrams || 100,
      servingLabel: i.servingLabel || `serving (${Math.round(i.servingGrams || 100)} g)`,
      qty: i.qty ?? i.grams,
      unit: i.unit || "g"
    }));
  }
  const totalGrams = ings.reduce((sum, i) => sum + (i.grams || 0), 0) || 100;
  const per100 = {};
  ["calories", "protein", "carbs", "fat"].forEach(k => { per100[k] = (meal.totals[k] || 0) * 100 / totalGrams; });
  return [{
    id: ++qaIngredientSeq,
    name: `${meal.name} (original recipe)`,
    brand: ings.map(i => i.name).join(", "),
    per100,
    servingGrams: totalGrams,
    servingLabel: `whole recipe (${Math.round(totalGrams)} g)`,
    qty: 1,
    unit: "serving"
  }];
}

// Older meals only stored name/brand/grams. Each ingredient originally came from Open Food Facts,
// so look it up again by name + brand to get its per-100 g nutrition back. Returns null if any can't be found.
async function qaRebuildLegacyIngredients(meal, signal) {
  const rebuilt = [];
  for (const saved of meal.ingredients || []) {
    const query = [saved.name, saved.brand].filter(Boolean).join(" ");
    const data = await qaFetchSearchWithRetry(query, signal);
    const products = (data.products || []).filter(p => p.product_name === saved.name);
    const match = products.find(p => (p.brands || "") === (saved.brand || "")) || products[0];
    if (!match) return null;
    const ing = qaIngredientFromProduct(match);
    ing.unit = "g";
    ing.qty = Math.round(saved.grams * 10) / 10;
    rebuilt.push(ing);
  }
  return rebuilt;
}

let qaRebuildAbort = null;

async function qaOpenEditModal(index) {
  const meal = qaGetSavedMeals()[index];
  if (!meal) return;
  qaOpenModal();
  qaEditingIndex = index;
  qaSetModalMode(true);
  qaServings = meal.servings || 1;
  document.getElementById("qa-meal-name").value = meal.name;
  qaAutoName = "";
  if (qaMealHasFullIngredients(meal)) {
    qaIngredients = qaIngredientsFromMeal(meal);
    qaRenderIngredients();
    return;
  }

  document.getElementById("qa-ingredients-list").innerHTML = `<div class="empty-state">Loading ingredients…</div>`;
  document.getElementById("qa-next-btn").disabled = true;
  if (qaRebuildAbort) qaRebuildAbort.abort();
  const ctrl = new AbortController();
  qaRebuildAbort = ctrl;
  let rebuilt = null;
  try {
    rebuilt = await qaRebuildLegacyIngredients(meal, ctrl.signal);
  } catch (err) {
    rebuilt = null;
  }
  // user closed the editor or opened a different meal while we were loading
  if (ctrl.signal.aborted || qaEditingIndex !== index || document.getElementById("quickadd-modal").hidden) return;
  qaIngredients = rebuilt || qaIngredientsFromMeal(meal);
  qaRenderIngredients();
  if (!rebuilt) {
    document.getElementById("qa-ingredients-list").insertAdjacentHTML("afterbegin",
      `<div class="qa-edit-note">Couldn't look up the original ingredients (check your connection), so this older meal is shown as one item. You can still scale it, add ingredients, or rename it.</div>`);
  }
}

function qaOpenModal() {
  if (qaRebuildAbort) qaRebuildAbort.abort();
  qaEditingIndex = null;
  qaSetModalMode(false);
  qaIngredients = [];
  qaIngredientSeq = 0;
  document.getElementById("qa-search-input").value = "";
  document.getElementById("qa-search-results").hidden = true;
  document.getElementById("qa-search-results").innerHTML = "";
  document.getElementById("qa-meal-name").value = "";
  qaAutoName = "";
  qaServings = 1;
  qaRenderIngredients();
  document.getElementById("qa-step-search").hidden = false;
  document.getElementById("qa-step-finalize").hidden = true;
  document.getElementById("quickadd-modal").hidden = false;
}
function qaCloseModal() {
  if (qaRebuildAbort) qaRebuildAbort.abort();
  document.getElementById("quickadd-modal").hidden = true;
}

document.getElementById("quickadd-btn").addEventListener("click", qaOpenModal);
document.getElementById("qa-close-btn").addEventListener("click", qaCloseModal);
document.getElementById("qa-close-btn-2").addEventListener("click", qaCloseModal);

// ---------- search (debounced, AU Open Food Facts) ----------
let qaSearchTimer = null;
document.getElementById("qa-search-input").addEventListener("input", e => {
  const q = e.target.value.trim();
  clearTimeout(qaSearchTimer);
  const resultsEl = document.getElementById("qa-search-results");
  if (!q) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    return;
  }
  resultsEl.hidden = false;
  resultsEl.innerHTML = `<div class="qa-result-loading">Searching…</div>`;
  qaSearchTimer = setTimeout(() => qaRunSearch(q), 350);
});

// Open Food Facts' search backend returns intermittent 503s under load (not a
// connectivity problem on the user's end) — retry a couple of times with a short
// backoff before giving up, and fetch from a couple of mirrors in case one is down.
const QA_SEARCH_ENDPOINTS = [
  query => `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&json=1&page_size=15&fields=product_name,brands,nutriments,serving_size,serving_quantity,image_small_url,code`,
  query => `https://au.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&json=1&page_size=15&fields=product_name,brands,nutriments,serving_size,serving_quantity,image_small_url,code`
];

function qaDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function qaFetchSearchWithRetry(query, signal) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const endpoint = QA_SEARCH_ENDPOINTS[attempt % QA_SEARCH_ENDPOINTS.length];
    try {
      const resp = await fetch(endpoint(query), { signal });
      if (resp.status === 503 || resp.status === 502 || resp.status === 429) {
        lastErr = new Error(`Server busy (${resp.status})`);
        if (attempt < 2) { await qaDelay(500 * (attempt + 1)); continue; }
        throw lastErr;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      if (attempt < 2) { await qaDelay(500 * (attempt + 1)); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

async function qaRunSearch(query) {
  const resultsEl = document.getElementById("qa-search-results");
  if (qaSearchAbort) qaSearchAbort.abort();
  const ctrl = new AbortController();
  qaSearchAbort = ctrl;
  try {
    const data = await qaFetchSearchWithRetry(query, ctrl.signal);
    if (ctrl.signal.aborted) return;
    const products = (data.products || []).filter(p => p.product_name);
    if (!products.length) {
      resultsEl.innerHTML = `<div class="qa-result-empty">No matches for "${query}". Try a different search.</div>`;
      return;
    }
    resultsEl.innerHTML = "";
    products.slice(0, 12).forEach(p => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "qa-result-item";
      btn.innerHTML = `${p.product_name}${p.brands ? `<span class="qa-result-brand">${p.brands}</span>` : ""}`;
      btn.addEventListener("click", () => qaAddProduct(p));
      resultsEl.appendChild(btn);
    });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    resultsEl.innerHTML = `<div class="qa-result-empty">The food database is temporarily busy. Wait a moment and try searching again.</div>`;
  }
}

// ---------- add a searched product as an ingredient card ----------
function qaIngredientFromProduct(p) {
  const n = p.nutriments || {};
  const per100 = {
    calories: n["energy-kcal_100g"] ?? 0,
    protein: n["proteins_100g"] ?? 0,
    carbs: n["carbohydrates_100g"] ?? 0,
    fat: n["fat_100g"] ?? 0
  };
  // serving_quantity is a top-level product field in Open Food Facts, not a nutriment
  const servingGrams = parseFloat(p.serving_quantity) > 0 ? parseFloat(p.serving_quantity) : 100;
  const ing = {
    id: ++qaIngredientSeq,
    name: p.product_name,
    brand: p.brands || "",
    per100,
    servingGrams,
    servingLabel: p.serving_size ? `serving (${Math.round(servingGrams)} g)` : `serving (${Math.round(servingGrams)} g)`,
    qty: 1,
    unit: "serving"
  };
  return ing;
}

function qaAddProduct(p) {
  const ing = qaIngredientFromProduct(p);
  qaIngredients.push(ing);
  document.getElementById("qa-search-input").value = "";
  document.getElementById("qa-search-results").hidden = true;
  document.getElementById("qa-search-results").innerHTML = "";
  qaRenderIngredients();
}

// grams represented by current qty+unit for a given ingredient
function qaIngredientGrams(ing) {
  if (ing.unit === "serving") return ing.qty * ing.servingGrams;
  if (ing.unit === "g") return ing.qty * 1;
  if (ing.unit === "oz") return ing.qty * 28.3495;
  return ing.qty * ing.servingGrams;
}
function qaIngredientMacros(ing) {
  const grams = qaIngredientGrams(ing);
  const factor = grams / 100;
  return {
    calories: ing.per100.calories * factor,
    protein: ing.per100.protein * factor,
    carbs: ing.per100.carbs * factor,
    fat: ing.per100.fat * factor
  };
}
function qaTotals() {
  return qaIngredients.reduce((acc, ing) => {
    const m = qaIngredientMacros(ing);
    acc.calories += m.calories; acc.protein += m.protein; acc.carbs += m.carbs; acc.fat += m.fat;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}
function qaFormatTotals(t) {
  return `${Math.round(t.calories)} kcal · P ${Math.round(t.protein)}g · C ${Math.round(t.carbs)}g · F ${Math.round(t.fat)}g`;
}

function qaIngredientMacrosHtml(m) {
  return `
        <span>P <strong>${Math.round(m.protein)}g</strong></span>
        <span>F <strong>${Math.round(m.fat)}g</strong></span>
        <span>C <strong>${Math.round(m.carbs)}g</strong></span>
        <span>Cal <strong>${Math.round(m.calories)}</strong></span>`;
}

function qaRenderIngredients() {
  const listEl = document.getElementById("qa-ingredients-list");
  const headingEl = document.getElementById("qa-ingredients-heading");
  const totalRowEl = document.getElementById("qa-total-row");
  const nextBtn = document.getElementById("qa-next-btn");

  headingEl.textContent = `Ingredients (${qaIngredients.length})`;
  nextBtn.disabled = qaIngredients.length === 0;

  if (!qaIngredients.length) {
    listEl.innerHTML = `<div class="empty-state">Search above and tap a result to add it.</div>`;
    totalRowEl.hidden = true;
    return;
  }

  totalRowEl.hidden = false;
  document.getElementById("qa-total-text").textContent = qaFormatTotals(qaTotals());

  listEl.innerHTML = "";
  qaIngredients.forEach(ing => {
    const m = qaIngredientMacros(ing);
    const unitLabel = ing.unit === "serving" ? ing.servingLabel : ing.unit === "g" ? "g" : "oz (28.3495 g)";
    const card = document.createElement("div");
    card.className = "qa-ingredient-card";
    card.innerHTML = `
      <div class="qa-ing-top">
        <div>
          <div class="qa-ing-name">${ing.name}</div>
          ${ing.brand ? `<div class="qa-ing-brand">${ing.brand}</div>` : ""}
        </div>
        <button type="button" class="qa-ing-remove" aria-label="Remove ${ing.name}">🗑</button>
      </div>
      <div class="qa-ing-controls">
        <input type="number" class="qa-ing-qty" value="${ing.qty}" min="0" step="0.5">
        <button type="button" class="qa-ing-unit-btn">${unitLabel}</button>
      </div>
      <div class="qa-ing-macros">${qaIngredientMacrosHtml(m)}</div>
    `;
    card.querySelector(".qa-ing-remove").addEventListener("click", () => {
      qaIngredients = qaIngredients.filter(x => x.id !== ing.id);
      qaRenderIngredients();
    });
    card.querySelector(".qa-ing-qty").addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      ing.qty = isNaN(v) || v < 0 ? 0 : v;
      // update numbers in place; re-rendering would destroy this input and close the iPhone keyboard
      card.querySelector(".qa-ing-macros").innerHTML = qaIngredientMacrosHtml(qaIngredientMacros(ing));
      document.getElementById("qa-total-text").textContent = qaFormatTotals(qaTotals());
    });
    card.querySelector(".qa-ing-unit-btn").addEventListener("click", () => qaOpenUnitPopup(ing));
    listEl.appendChild(card);
  });
}

// ---------- unit picker popup ----------
function qaOpenUnitPopup(ing) {
  qaUnitPopupTargetId = ing.id;
  const optsEl = document.getElementById("qa-unit-options");
  const options = [
    { key: "serving", label: ing.servingLabel },
    { key: "g", label: "g" },
    { key: "oz", label: "oz (28.3495 g)" }
  ];
  optsEl.innerHTML = "";
  options.forEach(o => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qa-unit-option" + (ing.unit === o.key ? " selected" : "");
    btn.textContent = o.label;
    btn.addEventListener("click", () => {
      ing.unit = o.key;
      document.getElementById("qa-unit-popup").hidden = true;
      qaRenderIngredients();
    });
    optsEl.appendChild(btn);
  });
  document.getElementById("qa-unit-popup").hidden = false;
}
document.getElementById("qa-unit-cancel-btn").addEventListener("click", () => {
  document.getElementById("qa-unit-popup").hidden = true;
});

// ---------- step navigation ----------
document.getElementById("qa-next-btn").addEventListener("click", () => {
  if (!qaIngredients.length) return;
  document.getElementById("qa-step-search").hidden = true;
  document.getElementById("qa-step-finalize").hidden = false;
  qaApplySuggestedName();
  qaRenderFinalize();
});
document.getElementById("qa-back-btn").addEventListener("click", () => {
  document.getElementById("qa-step-finalize").hidden = true;
  document.getElementById("qa-step-search").hidden = false;
});

let qaServings = 1;
function qaRenderFinalize() {
  const recapEl = document.getElementById("qa-recap-list");
  recapEl.innerHTML = "";
  qaIngredients.forEach(ing => {
    const m = qaIngredientMacros(ing);
    const row = document.createElement("div");
    row.className = "qa-recap-item";
    row.innerHTML = `<span class="qa-recap-name">${ing.name}</span><span>${Math.round(m.calories)} kcal</span>`;
    recapEl.appendChild(row);
  });
  const totals = qaTotals();
  document.getElementById("qa-total-text-2").textContent = qaFormatTotals(totals);
  document.getElementById("qa-servings-value").textContent = qaServings.toFixed(2);
  const per = {
    calories: totals.calories / qaServings,
    protein: totals.protein / qaServings,
    carbs: totals.carbs / qaServings,
    fat: totals.fat / qaServings
  };
  document.getElementById("qa-per-serving-text").textContent = `Per serving: ${qaFormatTotals(per)}`;
}
document.getElementById("qa-servings-minus").addEventListener("click", () => {
  qaServings = Math.max(0.25, Math.round((qaServings - 0.25) * 100) / 100);
  qaRenderFinalize();
});
document.getElementById("qa-servings-plus").addEventListener("click", () => {
  qaServings = Math.round((qaServings + 0.25) * 100) / 100;
  qaRenderFinalize();
});

// ---------- save / log ----------
function qaBuildMealObject() {
  const totals = qaTotals();
  const name = document.getElementById("qa-meal-name").value.trim() || "Unnamed Meal";
  return {
    name,
    servings: qaServings,
    ingredients: qaIngredients.map(ing => ({
      name: ing.name,
      brand: ing.brand,
      grams: qaIngredientGrams(ing),
      per100: ing.per100,
      servingGrams: ing.servingGrams,
      servingLabel: ing.servingLabel,
      qty: ing.qty,
      unit: ing.unit
    })),
    totals,
    perServing: {
      calories: totals.calories / qaServings,
      protein: totals.protein / qaServings,
      carbs: totals.carbs / qaServings,
      fat: totals.fat / qaServings
    },
    createdAt: new Date().toISOString()
  };
}

function qaSaveMealToLibrary(meal) {
  const meals = qaGetSavedMeals();
  if (qaEditingIndex !== null && meals[qaEditingIndex]) {
    meal.createdAt = meals[qaEditingIndex].createdAt;
    if (meals[qaEditingIndex].recipeId) meal.recipeId = meals[qaEditingIndex].recipeId;
    meal.updatedAt = new Date().toISOString();
    meals[qaEditingIndex] = meal;
  } else {
    meals.unshift(meal);
  }
  qaSetSavedMeals(meals);
}

document.getElementById("qa-save-only-btn").addEventListener("click", () => {
  const meal = qaBuildMealObject();
  qaSaveMealToLibrary(meal);
  qaCloseModal();
  renderSaved();
});

// log one serving's worth of nutrition to the food log
function qaLogMeal(meal) {
  addFoodEntry({
    name: meal.name,
    brand: "",
    image: "",
    serving: "1 serving",
    calories: meal.perServing.calories,
    protein: meal.perServing.protein,
    carbs: meal.perServing.carbs,
    fat: meal.perServing.fat
  });
  qaCloseModal();
  updateHomeStats();
}

document.getElementById("qa-log-save-btn").addEventListener("click", () => {
  const meal = qaBuildMealObject();
  qaSaveMealToLibrary(meal);
  qaLogMeal(meal);
  renderSaved();
});

document.getElementById("qa-log-only-btn").addEventListener("click", () => {
  qaLogMeal(qaBuildMealObject());
});

// ============================================================
// RECIPE INDEX — built-in recipes (data/recipes.json), log or save to My Meals
// ============================================================
const RECIPE_FILTERS = [
  ["all", "All"], ["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"], ["snack", "Snacks"],
  ["protein", "High Protein"], ["vegetarian", "Vegetarian"], ["quick", "Under 15 min"]
];
const RECIPE_CATEGORY_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };
const RECIPE_FRACTIONS = { 0.25: "¼", 0.5: "½", 0.75: "¾" };

let recipeDataPromise = null;
let recipeData = null;      // { foods, recipes }
let recipeFilter = "all";
let recipeCuisine = "all"; // "all" or a cuisine name
let recipeQuery = "";
let recipeOpenId = null;    // recipe shown in the detail view, null = list view
let recipeServings = 1;     // servings the user is making (scales ingredient amounts)
let recipeContext = null;   // set when opened from the meal plan: { exclude, logPortion, returnTo, onLogged }

function loadRecipes() {
  if (!recipeDataPromise) {
    recipeDataPromise = fetch("data/recipes.json")
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(data => { recipeData = data; return data; })
      .catch(err => { recipeDataPromise = null; throw err; });
  }
  return recipeDataPromise;
}

function recipePerServing(recipe, exclude = []) {
  const per = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  recipe.ingredients.filter(i => !exclude.includes(i.food)).forEach(i => {
    const p100 = recipeData.foods[i.food].per100;
    Object.keys(per).forEach(k => { per[k] += p100[k] * i.grams / 100; });
  });
  Object.keys(per).forEach(k => { per[k] /= recipe.servings; });
  return per;
}

function recipeIsHighProtein(per) {
  return per.protein >= 25 || per.protein * 4 >= per.calories * 0.3;
}

function recipeMatches(recipe) {
  const per = recipePerServing(recipe);
  const f = recipeFilter;
  if (RECIPE_CATEGORY_LABELS[f] && recipe.category !== f) return false;
  if (f === "protein" && !recipeIsHighProtein(per)) return false;
  if (f === "vegetarian" && !recipe.vegetarian) return false;
  if (f === "quick" && recipe.minutes > 15) return false;
  if (recipeCuisine !== "all" && recipe.cuisine !== recipeCuisine) return false;
  const q = recipeQuery.trim().toLowerCase();
  if (!q) return true;
  const haystack = [recipe.name, recipe.cuisine || "", ...recipe.ingredients.map(i => i.label), ...recipe.ingredients.map(i => recipeData.foods[i.food].name)]
    .join(" ").toLowerCase();
  return q.split(/\s+/).every(word => haystack.includes(word));
}

function recipeCuisines() {
  return [...new Set(recipeData.recipes.map(r => r.cuisine).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function recipeMetaLine(recipe) {
  return [RECIPE_CATEGORY_LABELS[recipe.category], recipe.cuisine, `${recipe.minutes} min`].filter(Boolean).join(" · ");
}

function recipeTagsHtml(recipe, per) {
  const tags = [];
  if (recipeIsHighProtein(per)) tags.push(`<span class="recipe-tag protein">High protein</span>`);
  if (recipe.vegetarian) tags.push(`<span class="recipe-tag veg">Vegetarian</span>`);
  if (recipe.minutes <= 15) tags.push(`<span class="recipe-tag quick">Quick</span>`);
  return tags.join("");
}

function recipeSavedId(recipe, exclude = []) {
  return exclude.length ? `${recipe.id}|without:${[...exclude].sort().join(",")}` : recipe.id;
}

function recipeIsSaved(recipe, exclude = []) {
  const id = recipeSavedId(recipe, exclude);
  return qaGetSavedMeals().some(m => m.recipeId === id);
}

function foodNames(keys) {
  return keys.map(k => recipeData.foods[k].name.toLowerCase()).join(", ");
}

function formatServings(n) {
  const s = formatRecipeQty(n, "");
  return `${s} serving${n <= 1 ? "" : "s"}`;
}

function renderRecipes() {
  const listView = document.getElementById("recipes-list-view");
  const detail = document.getElementById("recipe-detail");
  const listEl = document.getElementById("recipes-list");
  if (!recipeData) {
    listView.hidden = false;
    detail.hidden = true;
    listEl.innerHTML = `<div class="empty-state">Loading recipes…</div>`;
    loadRecipes().then(renderRecipes).catch(() => {
      listEl.innerHTML = `<div class="empty-state">Couldn't load recipes.<br>Check your connection and try again.</div>`;
    });
    return;
  }
  const open = recipeOpenId && recipeData.recipes.find(r => r.id === recipeOpenId);
  listView.hidden = !!open;
  detail.hidden = !open;
  if (open) renderRecipeDetail(open);
  else renderRecipeList();
}

function renderRecipeList() {
  document.getElementById("recipe-filters").innerHTML = RECIPE_FILTERS.map(([key, label]) =>
    `<button type="button" class="chip${recipeFilter === key ? " selected" : ""}" data-recipe-filter="${key}" role="tab" aria-selected="${recipeFilter === key}">${label}</button>`
  ).join("");
  document.getElementById("recipe-cuisine-filters").innerHTML = [["all", "All cuisines"], ...recipeCuisines().map(c => [c, c])].map(([key, label]) =>
    `<button type="button" class="chip${recipeCuisine === key ? " selected" : ""}" data-recipe-cuisine="${key}" role="tab" aria-selected="${recipeCuisine === key}">${label}</button>`
  ).join("");
  const matches = recipeData.recipes.filter(recipeMatches);
  document.getElementById("recipes-count").textContent = `${matches.length} recipe${matches.length === 1 ? "" : "s"}`;
  const listEl = document.getElementById("recipes-list");
  if (!matches.length) {
    listEl.innerHTML = `<div class="empty-state">No recipes match.<br>Try a different search or filter.</div>`;
    return;
  }
  listEl.innerHTML = matches.map(recipe => {
    const per = recipePerServing(recipe);
    return `<button type="button" class="recipe-card" data-recipe-id="${recipe.id}">
      <span class="recipe-emoji" aria-hidden="true">${recipe.emoji}</span>
      <span class="recipe-card-text">
        <span class="recipe-card-cat">${recipeMetaLine(recipe)}</span>
        <span class="recipe-card-title">${recipe.name}</span>
        <span class="recipe-card-macros">${Math.round(per.calories)} kcal · P ${Math.round(per.protein)}g · C ${Math.round(per.carbs)}g · F ${Math.round(per.fat)}g</span>
        <span class="recipe-tags">${recipeTagsHtml(recipe, per)}</span>
      </span>
      <span class="dash-card-arrow" aria-hidden="true">›</span>
    </button>`;
  }).join("");
}

function formatRecipeQty(qty, unit) {
  if (unit === "g" || unit === "ml") return String(qty >= 20 ? Math.round(qty / 5) * 5 : Math.round(qty));
  const quarters = Math.round(qty * 4) / 4;
  if (quarters <= 0) return "¼";
  const whole = Math.floor(quarters);
  const frac = RECIPE_FRACTIONS[quarters - whole] || "";
  return whole ? `${whole}${frac ? " " + frac : ""}` : frac;
}

function recipeIngredientText(ing, scale) {
  const qty = formatRecipeQty(ing.qty * scale, ing.unit);
  const unit = ing.unit === "g" || ing.unit === "ml" ? ing.unit : ing.unit ? " " + ing.unit : "";
  return `<span class="recipe-ing-qty">${qty}${unit}</span> ${ing.label}`;
}

function renderRecipeDetail(recipe) {
  const ctx = recipeContext || {};
  const exclude = ctx.exclude || [];
  const logPortion = ctx.logPortion || 1;
  const per = recipePerServing(recipe, exclude);
  const scale = recipeServings / recipe.servings;
  const saved = recipeIsSaved(recipe, exclude);
  const el = document.getElementById("recipe-detail");
  el.innerHTML = `
    <button type="button" class="saved-folder-back" id="recipe-back-btn">‹ ${ctx.returnTo === "mealplan-screen" ? "Meal Plan" : "Recipes"}</button>
    <div class="recipe-hero"><span aria-hidden="true">${recipe.emoji}</span></div>
    <div class="recipe-detail-cat">${recipeMetaLine(recipe)} · Serves ${recipe.servings}</div>
    <h2 class="recipe-detail-title">${recipe.name}</h2>
    <div class="recipe-tags">${recipeTagsHtml(recipe, per)}</div>
    ${exclude.length ? `<div class="recipe-left-out-note">Leaving out: ${foodNames(exclude)}. Nutrition below already accounts for it.</div>` : ""}
    <div class="recipe-macro-grid" aria-label="Nutrition per serving">
      <div class="recipe-macro"><span class="v">${Math.round(per.calories)}</span><span class="l">kcal</span></div>
      <div class="recipe-macro"><span class="v">${Math.round(per.protein)}g</span><span class="l">Protein</span></div>
      <div class="recipe-macro"><span class="v">${Math.round(per.carbs)}g</span><span class="l">Carbs</span></div>
      <div class="recipe-macro"><span class="v">${Math.round(per.fat)}g</span><span class="l">Fat</span></div>
    </div>
    <div class="recipe-per-note">Per serving</div>
    <div class="recipe-actions">
      <button type="button" class="primary-btn" id="recipe-log-btn">Log ${formatServings(logPortion).replace(" serving", " Serving")}</button>
      <button type="button" class="primary-btn secondary" id="recipe-save-btn"${saved ? " disabled" : ""}>${saved ? "✓ In My Meals" : "Save to My Meals"}</button>
    </div>
    <div class="recipe-section-head">
      <h3 class="section-heading">Ingredients</h3>
      <div class="qa-servings-stepper recipe-stepper">
        <button type="button" class="icon-btn" id="recipe-serv-minus" aria-label="Fewer servings">−</button>
        <span id="recipe-serv-value">${recipeServings} serving${recipeServings === 1 ? "" : "s"}</span>
        <button type="button" class="icon-btn" id="recipe-serv-plus" aria-label="More servings">+</button>
      </div>
    </div>
    <ul class="recipe-ingredients">${recipe.ingredients.map(i => exclude.includes(i.food)
      ? `<li class="left-out"><span class="recipe-ing-struck">${recipeIngredientText(i, scale)}</span><span class="recipe-left-out-tag">Left out</span></li>`
      : `<li>${recipeIngredientText(i, scale)}</li>`).join("")}</ul>
    <h3 class="section-heading">Method</h3>
    <ol class="recipe-steps">${recipe.steps.map(s => `<li>${s}</li>`).join("")}</ol>`;

  el.querySelector("#recipe-back-btn").addEventListener("click", () => {
    recipeOpenId = null;
    if (ctx.returnTo) { recipeContext = null; showTab(ctx.returnTo); }
    else renderRecipes();
    scrollScreenTo(0);
  });
  el.querySelector("#recipe-serv-minus").addEventListener("click", () => { recipeServings = Math.max(1, recipeServings - 1); renderRecipeDetail(recipe); });
  el.querySelector("#recipe-serv-plus").addEventListener("click", () => { recipeServings = Math.min(12, recipeServings + 1); renderRecipeDetail(recipe); });
  el.querySelector("#recipe-log-btn").addEventListener("click", e => {
    addFoodEntry({
      name: recipe.name, brand: "Recipe", image: "", serving: formatServings(logPortion),
      calories: per.calories * logPortion, protein: per.protein * logPortion, carbs: per.carbs * logPortion, fat: per.fat * logPortion
    });
    updateHomeStats();
    if (ctx.onLogged) ctx.onLogged();
    e.currentTarget.textContent = "✓ Logged to today";
    e.currentTarget.classList.add("done");
  });
  el.querySelector("#recipe-save-btn").addEventListener("click", () => {
    if (recipeIsSaved(recipe, exclude)) return;
    const meals = qaGetSavedMeals();
    meals.unshift(recipeToMeal(recipe, exclude));
    qaSetSavedMeals(meals);
    renderRecipeDetail(recipe);
  });
}

// saved-meal shape matches Quick Add meals so it can be logged and edited from Saved › Meals
function recipeToMeal(recipe, exclude = []) {
  const ingredients = recipe.ingredients.filter(i => !exclude.includes(i.food)).map(i => {
    const food = recipeData.foods[i.food];
    return { name: food.name, brand: "", grams: i.grams, per100: { ...food.per100 }, servingGrams: 100,
             servingLabel: "serving (100 g)", qty: i.grams, unit: "g" };
  });
  const per = recipePerServing(recipe, exclude);
  const totals = {};
  Object.keys(per).forEach(k => { totals[k] = per[k] * recipe.servings; });
  const name = exclude.length ? `${recipe.name} (no ${foodNames(exclude)})` : recipe.name;
  return { name, servings: recipe.servings, ingredients, totals, perServing: per,
           recipeId: recipeSavedId(recipe, exclude), createdAt: new Date().toISOString() };
}

function openRecipe(id) {
  const recipe = recipeData.recipes.find(r => r.id === id);
  if (!recipe) return;
  recipeOpenId = id;
  recipeContext = null;
  recipeServings = recipe.servings;
  renderRecipes();
  scrollScreenTo(0);
}

document.getElementById("recipes-btn").addEventListener("click", () => { recipeOpenId = null; recipeContext = null; showTab("recipes-screen"); });
document.getElementById("recipes-back-btn").addEventListener("click", () => showTab("nutrition-screen"));
document.getElementById("recipes-search").addEventListener("input", e => { recipeQuery = e.target.value; if (recipeData) renderRecipeList(); });
document.getElementById("recipe-filters").addEventListener("click", e => {
  const chip = e.target.closest("[data-recipe-filter]");
  if (!chip) return;
  recipeFilter = chip.dataset.recipeFilter;
  renderRecipeList();
});
document.getElementById("recipe-cuisine-filters").addEventListener("click", e => {
  const chip = e.target.closest("[data-recipe-cuisine]");
  if (!chip) return;
  recipeCuisine = chip.dataset.recipeCuisine;
  renderRecipeList();
});
document.getElementById("recipes-list").addEventListener("click", e => {
  const card = e.target.closest("[data-recipe-id]");
  if (card) openRecipe(card.dataset.recipeId);
});

// ============================================================
// MEAL PLAN — builds days of recipes around a calorie target, avoiding disliked foods.
// A disliked minor ingredient is left out of the recipe; a disliked main ingredient rules the recipe out.
// ============================================================
const MEALPLAN_KEY = "mealPlan";
const DISLIKES_KEY = "foodDislikes";
const MEAL_SLOTS = {
  breakfast: { label: "Breakfast", weight: 3 },
  lunch: { label: "Lunch", weight: 3.5 },
  dinner: { label: "Dinner", weight: 4 },
  snack: { label: "Snack", weight: 1.5 }
};
const LEAVE_OUT_MAX_KCAL_SHARE = 0.2;   // ingredient gives under 20% of the recipe's calories…
const LEAVE_OUT_MAX_GRAM_SHARE = 0.35;  // …and under 35% of its weight, so the dish still works without it
const MIN_PORTION = 0.5, MAX_PORTION = 3;

let mealPlanSettings = null; // form state while editing preferences
let mealPlanEditing = false;
let mealPlanDay = 0;
let dislikeQuery = "";

function getDislikes() {
  try { return JSON.parse(localStorage.getItem(DISLIKES_KEY)) || []; } catch (e) { return []; }
}
function setDislikes(list) { localStorage.setItem(DISLIKES_KEY, JSON.stringify(list)); }
function getMealPlan() {
  try { return JSON.parse(localStorage.getItem(MEALPLAN_KEY)); } catch (e) { return null; }
}
function setMealPlan(plan) { localStorage.setItem(MEALPLAN_KEY, JSON.stringify(plan)); }

function defaultMealPlanSettings() {
  return { days: 7, breakfast: true, lunch: true, dinner: true, snacks: 1,
           calories: getNutritionTargets().calories, vegetarian: false, cuisines: [] };
}

function canLeaveOut(recipe, food) {
  let kcal = 0, grams = 0, foodKcal = 0, foodGrams = 0;
  recipe.ingredients.forEach(i => {
    const k = recipeData.foods[i.food].per100.calories * i.grams / 100;
    kcal += k; grams += i.grams;
    if (i.food === food) { foodKcal += k; foodGrams += i.grams; }
  });
  return foodKcal <= kcal * LEAVE_OUT_MAX_KCAL_SHARE && foodGrams <= grams * LEAVE_OUT_MAX_GRAM_SHARE;
}

// null = recipe can't be used; otherwise the list of disliked foods to leave out (may be empty)
function recipeLeaveOuts(recipe, dislikes) {
  const used = [...new Set(recipe.ingredients.map(i => i.food))].filter(f => dislikes.includes(f));
  return used.every(f => canLeaveOut(recipe, f)) ? used : null;
}

function mealSlotsFor(settings) {
  const slots = [];
  if (settings.breakfast) slots.push("breakfast");
  if (settings.snacks >= 2) slots.push("snack");
  if (settings.lunch) slots.push("lunch");
  if (settings.snacks >= 1) slots.push("snack");
  if (settings.dinner) slots.push("dinner");
  return slots;
}

function slotCalorieTargets(settings) {
  const slots = mealSlotsFor(settings);
  const totalWeight = slots.reduce((s, k) => s + MEAL_SLOTS[k].weight, 0) || 1;
  return slots.map(k => ({ slot: k, target: settings.calories * MEAL_SLOTS[k].weight / totalWeight }));
}

function roundPortion(p) {
  return Math.min(MAX_PORTION, Math.max(MIN_PORTION, Math.round(p * 4) / 4));
}

function planCandidates(slot, settings, dislikes, excludeId, cuisines) {
  return recipeData.recipes
    .filter(r => r.category === slot && r.id !== excludeId && (!settings.vegetarian || r.vegetarian))
    .filter(r => !cuisines.length || cuisines.includes(r.cuisine))
    .map(r => ({ r, leftOut: recipeLeaveOuts(r, dislikes) }))
    .filter(o => o.leftOut);
}

function pickPlanMeal(slot, target, settings, dislikes, avoidIds, excludeId) {
  const cuisines = settings.cuisines || [];
  let options = planCandidates(slot, settings, dislikes, excludeId, cuisines);
  // Chosen cuisines have nothing for this slot (e.g. a Korean snack) — fall back to any cuisine
  if (!options.length && cuisines.length) options = planCandidates(slot, settings, dislikes, excludeId, []);
  if (!options.length) return { slot, recipeId: null, target };
  let best = null;
  options.forEach(o => {
    const per = recipePerServing(o.r, o.leftOut);
    const portion = roundPortion(target / per.calories);
    const score = Math.abs(Math.log((portion * per.calories) / target)) * 2   // close to the calorie target
      + Math.abs(Math.log(portion)) * 0.6                                       // prefer normal-sized portions
      + (avoidIds.includes(o.r.id) ? 3 : 0)                                    // variety across days
      + o.leftOut.length * 0.3                                                 // prefer dishes made as written
      + Math.random() * 0.8;
    if (!best || score < best.score) best = { score, meal: { slot, recipeId: o.r.id, portion, leftOut: o.leftOut, target, logged: false } };
  });
  return best.meal;
}

// nudge unlogged portions in ¼-serving steps until the day total is as close to target as it can get
function balanceDayPortions(day, target) {
  for (let step = 0; step < 24; step++) {
    const diff = target - planDayTotals(day).calories;
    let best = null;
    day.meals.forEach(m => {
      if (!m.recipeId || m.logged) return;
      [0.25, -0.25].forEach(delta => {
        const portion = m.portion + delta;
        if (portion < MIN_PORTION || portion > MAX_PORTION) return;
        const kcal = planMealNutrition({ ...m, portion: 1 }).calories * delta;
        const gain = Math.abs(diff) - Math.abs(diff - kcal);
        if (gain > 0 && (!best || gain > best.gain)) best = { m, portion, gain };
      });
    });
    if (!best) return;
    best.m.portion = best.portion;
  }
}

function generateMealPlan(settings) {
  const dislikes = getDislikes();
  const targets = slotCalorieTargets(settings);
  const days = [];
  for (let d = 0; d < settings.days; d++) {
    const recent = days.slice(-2).flatMap(day => day.meals.map(m => m.recipeId));
    const meals = [];
    targets.forEach(({ slot, target }) => {
      const avoid = [...recent, ...meals.map(m => m.recipeId)];
      meals.push(pickPlanMeal(slot, target, settings, dislikes, avoid, null));
    });
    const day = { meals };
    balanceDayPortions(day, settings.calories);
    days.push(day);
  }
  return { createdAt: new Date().toISOString(), settings: { ...settings }, dislikes, days };
}

function planMealNutrition(meal) {
  const recipe = recipeData.recipes.find(r => r.id === meal.recipeId);
  if (!recipe) return { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const per = recipePerServing(recipe, meal.leftOut);
  const out = {};
  Object.keys(per).forEach(k => { out[k] = per[k] * meal.portion; });
  return out;
}

function planDayTotals(day) {
  return day.meals.reduce((t, m) => {
    const n = planMealNutrition(m);
    Object.keys(t).forEach(k => { t[k] += n[k]; });
    return t;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

function planDayDone(day) {
  const real = day.meals.filter(m => m.recipeId);
  return real.length > 0 && real.every(m => m.logged);
}

function planShoppingList(plan) {
  const grams = {};
  plan.days.forEach(day => day.meals.forEach(m => {
    const recipe = recipeData.recipes.find(r => r.id === m.recipeId);
    if (!recipe) return;
    recipe.ingredients.filter(i => !m.leftOut.includes(i.food)).forEach(i => {
      grams[i.food] = (grams[i.food] || 0) + i.grams * m.portion / recipe.servings;
    });
  }));
  return Object.entries(grams)
    .map(([food, g]) => ({ name: recipeData.foods[food].name, grams: g }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatGrams(g) {
  return g >= 1000 ? `${(Math.round(g / 100) / 10).toLocaleString()} kg` : `${Math.max(5, Math.round(g / 5) * 5)} g`;
}

function renderMealPlan() {
  const body = document.getElementById("mealplan-body");
  if (!recipeData) {
    body.innerHTML = `<div class="empty-state">Loading recipes…</div>`;
    loadRecipes().then(renderMealPlan).catch(() => {
      body.innerHTML = `<div class="empty-state">Couldn't load recipes.<br>Check your connection and try again.</div>`;
    });
    return;
  }
  const plan = getMealPlan();
  if (!plan || mealPlanEditing) renderMealPlanSetup(plan);
  else renderMealPlanView(plan);
}

function chipHtml(attr, value, label, selected) {
  return `<button type="button" class="chip${selected ? " selected" : ""}" data-${attr}="${value}">${label}</button>`;
}

function renderMealPlanSetup(plan) {
  if (!mealPlanSettings) mealPlanSettings = plan ? { ...plan.settings } : defaultMealPlanSettings();
  const s = mealPlanSettings;
  const body = document.getElementById("mealplan-body");
  const noMeals = !mealSlotsFor(s).length;
  body.innerHTML = `
    <h2 class="mp-title">${plan ? "Edit Meal Plan" : "Build a Meal Plan"}</h2>
    <p class="mp-intro">Pick your preferences and we'll fill your days with recipes from the Recipe Index, sized to your calories.</p>
    <h3 class="goal-field-label">How many days?</h3>
    <div class="chip-group">${[3, 5, 7].map(n => chipHtml("mp-days", n, `${n} days`, s.days === n)).join("")}</div>
    <h3 class="goal-field-label">Meals</h3>
    <div class="chip-group">${["breakfast", "lunch", "dinner"].map(k => chipHtml("mp-slot", k, MEAL_SLOTS[k].label, s[k])).join("")}</div>
    <h3 class="goal-field-label">Snacks per day</h3>
    <div class="chip-group">${[0, 1, 2].map(n => chipHtml("mp-snacks", n, n === 0 ? "None" : String(n), s.snacks === n)).join("")}</div>
    <h3 class="goal-field-label">Calories per day</h3>
    <input type="number" id="mp-calories" class="mp-input" inputmode="numeric" min="1000" max="6000" step="50" value="${s.calories}">
    <div class="mp-hint">Starts from your Nutrition Goals (${getNutritionTargets().calories} kcal).</div>
    <h3 class="goal-field-label">Diet</h3>
    <div class="chip-group">${chipHtml("mp-veg", "1", "Vegetarian only", s.vegetarian)}</div>
    <h3 class="goal-field-label">Cuisines</h3>
    <div class="mp-hint">Pick the cuisines you feel like, or leave it on Any. If a cuisine has no recipe for a meal, we'll use another one.</div>
    <div class="chip-group mp-cuisines">${chipHtml("mp-cuisine", "any", "Any", !(s.cuisines || []).length)}${recipeCuisines().map(c => chipHtml("mp-cuisine", c, c, (s.cuisines || []).includes(c))).join("")}</div>
    <h3 class="goal-field-label">Foods I don't like <span id="mp-dislike-count" class="mp-dislike-count"></span></h3>
    <div class="mp-hint">Small ingredients get left out of a recipe. Recipes built around a food you don't like are skipped.</div>
    <div class="qa-search-wrap recipes-search-wrap">
      <span class="qa-search-icon" aria-hidden="true"><svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/></svg></span>
      <input type="search" id="mp-dislike-search" placeholder="Search ingredients" autocomplete="off" value="${dislikeQuery.replace(/"/g, "&quot;")}" aria-label="Search ingredients">
    </div>
    <div id="mp-dislike-grid" class="mp-dislike-grid"></div>
    <button type="button" id="mp-generate-btn" class="primary-btn"${noMeals ? " disabled" : ""}>${noMeals ? "Pick at least one meal" : plan ? "Update My Meal Plan" : "Create My Meal Plan"}</button>
    ${plan ? `<button type="button" id="mp-cancel-btn" class="primary-btn secondary">Cancel</button>` : ""}`;
  renderDislikeGrid();
  body.querySelector("#mp-dislike-search").addEventListener("input", e => { dislikeQuery = e.target.value; renderDislikeGrid(); });
  body.querySelector("#mp-calories").addEventListener("input", e => { s.calories = parseInt(e.target.value, 10) || s.calories; });
}

function renderDislikeGrid() {
  const dislikes = getDislikes();
  const q = dislikeQuery.trim().toLowerCase();
  const foods = Object.entries(recipeData.foods)
    .filter(([key, f]) => !q || f.name.toLowerCase().includes(q) || dislikes.includes(key))
    .sort((a, b) => (dislikes.includes(b[0]) - dislikes.includes(a[0])) || a[1].name.localeCompare(b[1].name));
  document.getElementById("mp-dislike-grid").innerHTML = foods.length
    ? foods.map(([key, f]) => `<button type="button" class="chip mp-dislike${dislikes.includes(key) ? " disliked" : ""}" data-mp-dislike="${key}">${dislikes.includes(key) ? "✕ " : ""}${f.name}</button>`).join("")
    : `<div class="mp-hint">No ingredients match.</div>`;
  document.getElementById("mp-dislike-count").textContent = dislikes.length ? `(${dislikes.length} avoided)` : "";
}

function renderMealPlanView(plan) {
  if (mealPlanDay >= plan.days.length) mealPlanDay = 0;
  const day = plan.days[mealPlanDay];
  const totals = planDayTotals(day);
  const target = plan.settings.calories;
  const body = document.getElementById("mealplan-body");
  body.innerHTML = `
    <div class="mp-summary">
      <div>
        <div class="mp-summary-title">${plan.days.length}-Day Meal Plan</div>
        <div class="mp-summary-sub">~${target.toLocaleString()} kcal a day${plan.settings.vegetarian ? " · Vegetarian" : ""}${(plan.settings.cuisines || []).length ? ` · ${plan.settings.cuisines.join(", ")}` : ""}${plan.dislikes.length ? ` · Avoiding ${plan.dislikes.length} food${plan.dislikes.length === 1 ? "" : "s"}` : ""}</div>
      </div>
    </div>
    <div class="mp-top-actions">
      <button type="button" class="primary-btn secondary" id="mp-edit-btn">Edit Preferences</button>
      <button type="button" class="primary-btn secondary" id="mp-new-btn">↻ New Plan</button>
    </div>
    <div class="mp-day-pills">${plan.days.map((d, i) => `<button type="button" class="mp-day-pill${i === mealPlanDay ? " active" : ""}${planDayDone(d) ? " done" : ""}" data-mp-day="${i}">${planDayDone(d) ? "✓ " : ""}Day ${i + 1}</button>`).join("")}</div>
    <div class="mp-day-totals">
      <div class="mp-day-kcal"><b>${Math.round(totals.calories).toLocaleString()}</b> / ${target.toLocaleString()} kcal</div>
      <div class="mp-day-macros">P ${Math.round(totals.protein)}g · C ${Math.round(totals.carbs)}g · F ${Math.round(totals.fat)}g</div>
    </div>
    <div class="mp-meals">${day.meals.map((m, i) => planMealCardHtml(m, i)).join("")}</div>
    <details class="mp-shopping">
      <summary>🛒 Shopping list for all ${plan.days.length} days</summary>
      <ul>${planShoppingList(plan).map(it => `<li><span>${it.name}</span><span class="mp-shop-qty">${formatGrams(it.grams)}</span></li>`).join("")}</ul>
    </details>`;
}

function planMealCardHtml(meal, index) {
  const slot = MEAL_SLOTS[meal.slot].label;
  if (!meal.recipeId) {
    return `<div class="mp-meal empty"><div class="mp-meal-slot">${slot}</div>
      <div class="mp-meal-none">No ${slot.toLowerCase()} recipes left without your avoided foods. Try removing one from Foods I don't like.</div></div>`;
  }
  const recipe = recipeData.recipes.find(r => r.id === meal.recipeId);
  const n = planMealNutrition(meal);
  return `<div class="mp-meal${meal.logged ? " logged" : ""}" data-mp-meal="${index}">
    <button type="button" class="mp-meal-main" data-mp-open="${index}">
      <span class="recipe-emoji" aria-hidden="true">${recipe.emoji}</span>
      <span class="recipe-card-text">
        <span class="recipe-card-cat">${slot}</span>
        <span class="recipe-card-title">${recipe.name}</span>
        <span class="recipe-card-macros">${formatServings(meal.portion)} · ${Math.round(n.calories)} kcal · P ${Math.round(n.protein)}g</span>
        ${meal.leftOut.length ? `<span class="mp-left-out">Leaving out: ${foodNames(meal.leftOut)}</span>` : ""}
      </span>
    </button>
    <div class="mp-meal-actions">
      <button type="button" class="mp-action" data-mp-swap="${index}" aria-label="Swap for a different recipe">↻ Swap</button>
      <button type="button" class="mp-action log${meal.logged ? " done" : ""}" data-mp-log="${index}">${meal.logged ? "✓ Logged" : "+ Log"}</button>
    </div>
  </div>`;
}

function logPlanMeal(plan, meal) {
  const recipe = recipeData.recipes.find(r => r.id === meal.recipeId);
  const n = planMealNutrition(meal);
  addFoodEntry({ name: recipe.name, brand: "Meal Plan", image: "", serving: formatServings(meal.portion), ...n });
  updateHomeStats();
  meal.logged = true;
  setMealPlan(plan);
}

document.getElementById("mealplan-btn").addEventListener("click", () => showTab("mealplan-screen"));
document.getElementById("mealplan-back-btn").addEventListener("click", () => showTab("nutrition-screen"));
document.getElementById("mealplan-body").addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t) return;
  const s = mealPlanSettings;
  const plan = getMealPlan();
  if (t.dataset.mpDays) { s.days = +t.dataset.mpDays; return renderMealPlanSetup(plan); }
  if (t.dataset.mpSlot) { s[t.dataset.mpSlot] = !s[t.dataset.mpSlot]; return renderMealPlanSetup(plan); }
  if (t.dataset.mpSnacks) { s.snacks = +t.dataset.mpSnacks; return renderMealPlanSetup(plan); }
  if (t.dataset.mpVeg) { s.vegetarian = !s.vegetarian; return renderMealPlanSetup(plan); }
  if (t.dataset.mpCuisine) {
    const c = t.dataset.mpCuisine, list = s.cuisines || [];
    s.cuisines = c === "any" ? [] : list.includes(c) ? list.filter(x => x !== c) : [...list, c];
    return renderMealPlanSetup(plan);
  }
  if (t.dataset.mpDislike) {
    const key = t.dataset.mpDislike;
    const list = getDislikes();
    setDislikes(list.includes(key) ? list.filter(k => k !== key) : [...list, key]);
    return renderDislikeGrid();
  }
  if (t.id === "mp-generate-btn") {
    const cal = parseInt(document.getElementById("mp-calories").value, 10);
    s.calories = Math.min(6000, Math.max(1000, cal || getNutritionTargets().calories));
    setMealPlan(generateMealPlan(s));
    mealPlanEditing = false; mealPlanSettings = null; mealPlanDay = 0;
    renderMealPlan(); scrollScreenTo(0);
    return;
  }
  if (t.id === "mp-cancel-btn") { mealPlanEditing = false; mealPlanSettings = null; return renderMealPlan(); }
  if (!plan) return;
  if (t.id === "mp-edit-btn") { mealPlanEditing = true; mealPlanSettings = { ...plan.settings }; renderMealPlan(); scrollScreenTo(0); return; }
  if (t.id === "mp-new-btn") {
    if (plan.days.some(d => d.meals.some(m => m.logged)) && !confirm("Make a new plan? Your current plan will be replaced (logged meals stay in your food log).")) return;
    setMealPlan(generateMealPlan(plan.settings)); mealPlanDay = 0; return renderMealPlan();
  }
  if (t.dataset.mpDay) { mealPlanDay = +t.dataset.mpDay; return renderMealPlan(); }
  const day = plan.days[mealPlanDay];
  if (t.dataset.mpSwap) {
    const i = +t.dataset.mpSwap, old = day.meals[i];
    const avoid = plan.days.flatMap(d => d.meals.map(m => m.recipeId));
    day.meals[i] = pickPlanMeal(old.slot, old.target, plan.settings, getDislikes(), avoid, old.recipeId);
    if (!day.meals[i].recipeId) day.meals[i] = old; // nothing else fits: keep the current meal
    balanceDayPortions(day, plan.settings.calories);
    setMealPlan(plan);
    return renderMealPlan();
  }
  if (t.dataset.mpLog) {
    const meal = day.meals[+t.dataset.mpLog];
    if (!meal.logged) logPlanMeal(plan, meal);
    return renderMealPlan();
  }
  if (t.dataset.mpOpen) {
    const dayIndex = mealPlanDay, mealIndex = +t.dataset.mpOpen;
    const meal = day.meals[mealIndex];
    const recipe = recipeData.recipes.find(r => r.id === meal.recipeId);
    recipeOpenId = recipe.id;
    recipeServings = recipe.servings;
    recipeContext = {
      exclude: meal.leftOut, logPortion: meal.portion, returnTo: "mealplan-screen",
      onLogged: () => { const p = getMealPlan(); if (p && p.days[dayIndex]) { p.days[dayIndex].meals[mealIndex].logged = true; setMealPlan(p); } }
    };
    showTab("recipes-screen");
    scrollScreenTo(0);
  }
});


// ============================================================
// CARDIO (v37) — its own section, kept out of strength training sessions.
// Tailored by type, where, skill level, intensity, goal and duration;
// builds a warm-up / main set / cool-down session with a step timer.
// ============================================================
const CARDIO_PREFS_KEY = "cardioPrefs";
const CARDIO_WEEKLY_TARGET_MIN = 150; // Australian guideline: 150–300 min moderate activity a week

// met = [easy, moderate, hard, all-out] MET values (Compendium of Physical Activities, rounded)
const CARDIO_TYPES = {
  run: { label: "Run", met: [7, 9.8, 11.5, 14], muscles: ["quads", "hamstrings", "calves", "glutes"], where: ["outdoor", "treadmill"], impact: true },
  walk: { label: "Walk", met: [3.5, 4.8, 6.5, 7.5], muscles: ["quads", "calves", "glutes"], where: ["outdoor", "treadmill"] },
  cycle: { label: "Cycle", met: [5.5, 7.5, 10, 12], muscles: ["quads", "glutes", "calves"], where: ["outdoor", "bike"] },
  row: { label: "Row", met: [4.8, 7, 8.5, 12], muscles: ["back", "quads", "biceps", "glutes"] },
  hiit: { label: "HIIT (no equipment)", met: [5, 8, 10, 12], muscles: ["full body"] },
  rope: { label: "Jump Rope", met: [8.8, 11, 12.3, 13], muscles: ["calves", "shoulders", "quads"], impact: true },
  swim: { label: "Swim", met: [5.8, 7, 9.8, 11], muscles: ["back", "shoulders", "chest"] },
  elliptical: { label: "Elliptical", met: [4.6, 5.8, 7.5, 9], muscles: ["quads", "glutes"] },
  stairs: { label: "Stair Climber", met: [4, 8.8, 9.5, 11], muscles: ["quads", "glutes", "calves"] }
};
const CARDIO_WHERE_LABELS = { outdoor: "Outdoors", treadmill: "Treadmill", bike: "Stationary bike" };
const CARDIO_LEVELS = {
  new: { label: "Beginner", hint: "New to cardio, or coming back after a break" },
  some: { label: "Intermediate", hint: "You do some cardio most months" },
  fit: { label: "Advanced", hint: "You train cardio most weeks" },
  athlete: { label: "Athlete", hint: "You race or train hard regularly" }
};
const CARDIO_LEVEL_INDEX = { new: 0, some: 1, fit: 2, athlete: 3 };
const CARDIO_INTENSITIES = { easy: "Easy", moderate: "Moderate", hard: "Hard" };
const CARDIO_INTENSITY_SHIFT = { easy: -1, moderate: 0, hard: 1 };
const CARDIO_GOALS = {
  fatburn: { label: "Fat Burn", hint: "Steady effort you can hold for a long time" },
  endurance: { label: "Endurance", hint: "Longer efforts so you can go further" },
  speed: { label: "Speed & Power", hint: "Short, fast intervals with recovery between" },
  heart: { label: "Heart Health", hint: "Easy–moderate pace with short pick-ups" }
};
const CARDIO_DURATIONS = [10, 15, 20, 30, 45, 60];
const CARDIO_DEFAULTS = { type: "run", where: "outdoor", level: "some", intensity: "moderate", goal: "fatburn", minutes: 30 };

// HIIT moves by skill level (low impact for beginners)
const HIIT_MOVES = [
  ["March on the Spot", "Step Jacks", "Bodyweight Squats", "Standing Knee Drives", "Step-Back Lunges", "Shadow Boxing"],
  ["Jumping Jacks", "High Knees", "Mountain Climbers", "Skaters", "Butt Kicks", "Squat to Calf Raise"],
  ["Burpees", "Jump Squats", "Mountain Climbers", "Skaters", "Plank Jacks", "High Knees"],
  ["Burpees", "Tuck Jumps", "Jump Lunges", "Sprint on the Spot", "Plank Jacks", "Skaters"]
];

function getCardioPrefs() {
  try { return { ...CARDIO_DEFAULTS, ...JSON.parse(localStorage.getItem(CARDIO_PREFS_KEY) || "{}") }; }
  catch (e) { return { ...CARDIO_DEFAULTS }; }
}
function setCardioPrefs(p) { localStorage.setItem(CARDIO_PREFS_KEY, JSON.stringify(p)); }

function cardioBodyWeight() {
  const p = getNutritionTargets().profile;
  return p && p.weightKg > 0 ? Number(p.weightKg) : 75;
}

// MET for a given effort (RPE 1-10) on a cardio type
function cardioMet(type, rpe) {
  const met = (CARDIO_TYPES[type] || CARDIO_TYPES.run).met;
  if (rpe <= 2) return 2.5;
  if (rpe <= 3) return Math.min(met[0], 4);
  if (rpe <= 5) return met[0];
  if (rpe <= 6) return met[1];
  if (rpe <= 8) return met[2];
  return met[3];
}
function cardioKcal(type, rpe, seconds, kg = cardioBodyWeight()) {
  return cardioMet(type, rpe) * kg * seconds / 3600;
}
// Typical effort for a whole session of a given intensity (used for quick logs)
const CARDIO_INTENSITY_RPE = { easy: 4, moderate: 6, hard: 7.5 };

// Effort (RPE) → heart-rate zone
const HR_ZONES = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 100]];
function cardioZone(rpe) { return rpe <= 3 ? 1 : rpe <= 5 ? 2 : rpe <= 6 ? 3 : rpe <= 8 ? 4 : 5; }
function cardioZoneText(rpe) {
  const z = cardioZone(rpe);
  const p = getNutritionTargets().profile;
  const age = p && p.age > 0 ? Number(p.age) : null;
  if (!age) return `Zone ${z}`;
  const max = 220 - age;
  const [lo, hi] = HR_ZONES[z - 1];
  return `Zone ${z} · ${Math.round(max * lo / 100)}–${Math.round(max * hi / 100)} bpm`;
}
const RPE_WORDS = { 1: "Very easy", 2: "Very easy", 3: "Easy", 4: "Easy", 5: "Moderate", 6: "Moderate", 7: "Hard", 8: "Hard", 9: "Very hard", 10: "All out" };

// What to actually do at a given effort, per cardio type
function cardioCue(type, rpe, where, level) {
  const li = CARDIO_LEVEL_INDEX[level] ?? 1;
  const r = Math.round(rpe);
  if (type === "run") {
    const cue = r <= 3 ? "Walk briskly to recover" : r <= 4 ? "Very easy jog" : r <= 5 ? "Easy jog — you could hold a chat" : r <= 6 ? "Comfortable steady run" : r <= 7 ? "Strong pace — a few words at a time" : r <= 8 ? "Hard — about 5K race pace" : "Sprint — fast but in control";
    if (where !== "treadmill") return cue;
    const base = [7, 8.5, 9.5, 11][li];
    const speed = r <= 3 ? 5.5 : base + ({ 4: -1, 5: 0, 6: 1, 7: 2, 8: 3 }[r] ?? 4.5);
    return `${cue} · ~${speed.toFixed(1)} km/h`;
  }
  if (type === "walk") {
    const cue = r <= 3 ? "Easy stroll" : r <= 4 ? "Steady walk" : r <= 5 ? "Brisk walk — slightly out of breath" : r <= 6 ? "Fast walk, pump your arms" : where === "treadmill" ? "Fast walk on a steep incline" : "Power walk uphill or up stairs";
    if (where !== "treadmill") return cue;
    const speed = [4.5, 5, 5.5, 6][li] + (r >= 5 ? 0.5 : 0);
    const incline = { 3: 1, 4: 2, 5: 4, 6: 6, 7: 8, 8: 10 }[r] ?? (r < 3 ? 0 : 12);
    return `${cue} · ~${speed.toFixed(1)} km/h, ${incline}% incline`;
  }
  if (type === "cycle") {
    if (r <= 3) return "Easy spin, light resistance (~80 rpm)";
    if (r <= 5) return "Steady pedalling, medium resistance (~85 rpm)";
    if (r <= 6) return "Comfortably hard — add a little resistance";
    if (r <= 8) return where === "outdoor" ? "Hard effort — big gear or a hill" : "Hard effort — heavy resistance, 80–90 rpm";
    return "Sprint — fast cadence (100+ rpm)";
  }
  if (type === "row") {
    if (r <= 3) return "Easy rowing, 18–20 strokes/min";
    if (r <= 5) return "Steady, 20–22 strokes/min — push with the legs first";
    if (r <= 6) return "Firm drive, 22–24 strokes/min";
    if (r <= 8) return "Strong, 24–28 strokes/min";
    return "Hard piece, 28–32 strokes/min";
  }
  if (type === "rope") {
    if (r <= 3) return "Rest — walk around and shake out";
    if (r <= 5) return "Basic bounce, relaxed";
    if (r <= 6) return "Alternate-foot step";
    if (r <= 8) return "Fast singles";
    return li >= 2 ? "Double-unders, or your fastest singles" : "Fastest singles you can hold";
  }
  if (type === "swim") {
    if (r <= 3) return "Easy laps — any stroke or a kickboard";
    if (r <= 5) return "Steady freestyle, long smooth strokes";
    if (r <= 6) return "Steady freestyle, a touch quicker";
    if (r <= 8) return "Strong pace — breathe every 2–3 strokes";
    return "Fast laps — sprint, then ease off";
  }
  if (type === "elliptical") {
    if (r <= 3) return "Easy pace, low resistance";
    if (r <= 5) return "Steady stride, medium resistance";
    if (r <= 8) return "Raise resistance and drive with your legs";
    return "Max effort — high resistance, fast stride";
  }
  if (type === "stairs") {
    if (r <= 3) return "Slow climb, level 3–4";
    if (r <= 5) return "Steady climb, level 5–7";
    if (r <= 8) return "Strong climb, level 8–10 — don't lean on the rails";
    return "Hard climb, level 11+";
  }
  if (type === "hiit") return r <= 3 ? "Rest — catch your breath" : r <= 5 ? "Easy moves — march, step jacks, arm circles" : "Go hard — good form first";
  return r <= 3 ? "Rest — catch your breath" : "Keep moving";
}
// Cue for a session step: warm-ups and cool-downs get their own wording
function cardioStepCue(pt, p) {
  if (pt.kind === "warm") return `Start easy and build up · ${cardioCue(p.type, 4, p.where, p.level)}`;
  if (pt.kind === "cool") return `Slow right down, then stretch · ${cardioCue(p.type, 4, p.where, p.level).replace(/^Very easy jog/, "Easy jog or walk")}`;
  return cardioCue(p.type, pt.rpe, p.where, p.level);
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const round5 = s => Math.max(5, Math.round(s / 5) * 5);

// Build a session. Returns { params, blocks:[{title, reps, parts:[{label,sec,rpe,kind}]}], steps, totalSec, kcal }
function buildCardioSession(params) {
  const p = { ...CARDIO_DEFAULTS, ...params };
  const type = CARDIO_TYPES[p.type] ? p.type : "run";
  const li = CARDIO_LEVEL_INDEX[p.level] ?? 1;
  const is = CARDIO_INTENSITY_SHIFT[p.intensity] ?? 0;
  const total = Math.max(5, Math.round(p.minutes || 30)) * 60;
  const warm = Math.min(8, Math.max(3, Math.round(p.minutes * 0.15))) * 60;
  const cool = Math.min(5, Math.max(2, Math.round(p.minutes * 0.1))) * 60;
  let main = total - warm - cool;
  const blocks = [];
  const part = (label, sec, rpe, kind) => ({ label, sec, rpe, kind });
  blocks.push({ title: "Warm-up", reps: 1, parts: [part("Warm-up", warm, 3, "warm")] });

  // fits a repeated work/recover pair into the main time; returns leftover seconds
  const intervals = (title, workSec, workRpe, restSec, restRpe, workLabel, restLabel, maxReps = 99) => {
    const cycle = workSec + restSec;
    const reps = Math.max(1, Math.min(maxReps, Math.floor(main / cycle)));
    blocks.push({ title, reps, parts: [part(workLabel, workSec, workRpe, "work"), part(restLabel, restSec, restRpe, "rest")] });
    return main - reps * cycle;
  };
  let leftover = 0;

  if (type === "hiit") {
    const work = Math.max(15, [20, 30, 40, 45][li] + is * 5);
    const rest = Math.max(10, [40, 30, 20, 15][li] - is * 5 + (p.goal === "speed" ? 10 : 0));
    const moves = shuffled(HIIT_MOVES[li]).slice(0, 5);
    const roundRest = 60;
    const roundSec = moves.length * (work + rest) + roundRest;
    const rounds = Math.max(1, Math.floor(main / roundSec));
    const parts = [];
    moves.forEach(m => { parts.push(part(m, work, 8 + (is > 0 ? 1 : 0), "work")); parts.push(part("Rest", rest, 2, "rest")); });
    parts.push(part("Round rest — sip water", roundRest, 2, "rest"));
    blocks.push({ title: "Circuit rounds", reps: rounds, parts });
    leftover = main - rounds * roundSec;
  } else if (p.goal === "speed") {
    const work = [20, 30, 30, 40][li];
    const rest = round5([100, 90, 60, 40][li] * ({ easy: 1.5, moderate: 1, hard: 0.75 }[p.intensity] || 1));
    leftover = intervals("Speed intervals", work, is < 0 ? 8 : 9, rest, 3, "Fast", "Easy", [6, 8, 10, 12][li]);
  } else if (p.goal === "endurance") {
    const work = [3, 5, 8, 10][li] * 60;
    const rest = (is > 0 ? 1 : 2) * 60;
    if (main < work + rest) blocks.push({ title: "Steady", reps: 1, parts: [part("Steady", main, 5 + Math.max(0, is), "steady")] });
    else leftover = intervals("Tempo intervals", work, 6 + is, rest, 4, "Tempo", "Easy");
  } else if (p.goal === "heart") {
    const steady = [4, 3, 3, 2][li] * 60;
    leftover = intervals("Steady + pick-ups", steady, 5, 60, 7 + is, "Steady", "Pick-up");
    // pick-ups are the harder part — relabel kinds so the timer colours them right
    const b = blocks[blocks.length - 1];
    b.parts[0].kind = "steady"; b.parts[1].kind = "work";
  } else if (li === 0 && CARDIO_TYPES[type].impact) {
    // fat burn for beginners on high-impact types: run/walk (or skip/rest) intervals
    const work = { easy: 60, moderate: 90, hard: 120 }[p.intensity] || 90;
    const rest = { easy: 90, moderate: 60, hard: 60 }[p.intensity] || 60;
    leftover = intervals(type === "run" ? "Run / walk" : "Skip / rest", work, 5, rest, 3, type === "run" ? "Jog" : "Skip", type === "run" ? "Walk" : "Rest");
  } else if (is > 0) {
    leftover = intervals("Steady + surges", 240, 6, 60, 7, "Steady", "Surge");
    const b = blocks[blocks.length - 1];
    b.parts[0].kind = "steady"; b.parts[1].kind = "work";
  } else {
    blocks.push({ title: "Steady", reps: 1, parts: [part("Steady", main, 5 + is, "steady")] });
  }

  if (leftover >= 60) blocks.push({ title: "Easy steady", reps: 1, parts: [part("Easy steady", leftover, 4, "steady")] });
  const coolSec = cool + (leftover < 60 ? leftover : 0);
  blocks.push({ title: "Cool-down", reps: 1, parts: [part("Cool-down", coolSec, 2, "cool")] });

  const steps = [];
  blocks.forEach(b => {
    for (let r = 1; r <= b.reps; r++) b.parts.forEach(pt => steps.push({ ...pt, block: b.title, rep: r, reps: b.reps }));
  });
  const totalSec = steps.reduce((s, x) => s + x.sec, 0);
  const kg = cardioBodyWeight();
  const kcal = Math.round(steps.reduce((s, x) => s + cardioKcal(type, x.rpe, x.sec, kg), 0));
  return { params: { ...p, type }, blocks, steps, totalSec, kcal };
}

function cardioSessionTitle(s) {
  const p = s.params;
  return `${Math.round(s.totalSec / 60)}-min ${CARDIO_TYPES[p.type].label} · ${CARDIO_GOALS[p.goal].label}`;
}
function fmtSec(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}
function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// ---------- cardio history (stored in workoutHistory so Recovery sees it) ----------
function cardioEntries(history = getWorkoutHistory()) { return history.filter(h => h.cardio); }
function startOfWeek(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}
function cardioWeekStats(history = getWorkoutHistory(), now = new Date()) {
  const from = startOfWeek(now).getTime();
  const week = cardioEntries(history).filter(h => new Date(h.finishedAt).getTime() >= from);
  return {
    sessions: week.length,
    minutes: Math.round(week.reduce((s, h) => s + (h.cardio.minutes || 0), 0)),
    kcal: Math.round(week.reduce((s, h) => s + (h.cardio.kcal || 0), 0))
  };
}
function recordCardio({ type, minutes, kcal, distanceKm, intensity, goal, title }) {
  const t = CARDIO_TYPES[type] || CARDIO_TYPES.run;
  const sets = Array.from({ length: Math.max(1, Math.round(minutes / 10)) }, () => ({ reps: 0, weight: 0 }));
  const entry = {
    id: `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    finishedAt: new Date().toISOString(),
    title: title || `${t.label} · ${minutes} min`,
    goal: "cardio",
    duration: minutes,
    cardio: { type, minutes, kcal: Math.round(kcal), distanceKm: distanceKm || null, intensity: intensity || null, goal: goal || null },
    exercises: [{ name: t.label, type: "cardio", muscles: t.muscles, sets }]
  };
  const history = getWorkoutHistory();
  history.unshift(entry);
  setWorkoutHistory(history);
  return entry;
}

// ---------- cardio screen UI ----------
let cardioView = "setup";   // setup | session | timer | log
let cardioPrefs = null;     // form state
let cardioSession = null;   // built session
let cardioRun = null;       // { idx, stepEndsAt, paused, remaining, spent, timer }
let cardioLogDraft = null;  // { type, minutes, distanceKm, intensity, goal, kcalPerMin, fromTimer }

function cardioOptHtml(attr, value, title, desc, selected) {
  return `<button type="button" class="chip activity-opt cardio-opt${selected ? " selected" : ""}" data-${attr}="${value}"><span class="ao-head"><span class="ao-title">${title}</span></span><span class="ao-desc">${desc}</span></button>`;
}
function cardioWeekCardHtml() {
  const w = cardioWeekStats();
  const pct = Math.min(100, Math.round(w.minutes / CARDIO_WEEKLY_TARGET_MIN * 100));
  return `<div class="card cardio-week">
    <div class="cardio-week-top"><span class="cardio-week-title">This week</span><span class="cardio-week-nums">${w.minutes} / ${CARDIO_WEEKLY_TARGET_MIN} min</span></div>
    <div class="rec-bar"><div class="rec-bar-fill fresh" style="width:${pct}%"></div></div>
    <div class="mp-hint">${w.sessions} session${w.sessions === 1 ? "" : "s"} · ~${w.kcal} kcal burned. Aim for 150–300 min of moderate cardio a week (or 75–150 min hard).</div>
  </div>`;
}

function renderCardio() {
  const body = document.getElementById("cardio-body");
  if (!body) return;
  if (cardioView === "timer" && cardioRun) return renderCardioTimer();
  if (cardioView === "session" && cardioSession) return renderCardioSession();
  if (cardioView === "log" && cardioLogDraft) return renderCardioLog();
  cardioView = "setup";
  renderCardioSetup();
}

function renderCardioSetup() {
  if (!cardioPrefs) cardioPrefs = getCardioPrefs();
  const p = cardioPrefs;
  const t = CARDIO_TYPES[p.type] || CARDIO_TYPES.run;
  if (t.where && !t.where.includes(p.where)) p.where = t.where[0];
  const recent = cardioEntries().slice(0, 5);
  document.getElementById("cardio-body").innerHTML = `
    <p class="mp-intro cd-intro">Cardio has its own section, separate from your strength sessions. Set it up to suit you.</p>
    ${cardioWeekCardHtml()}
    <h3 class="goal-field-label">Type</h3>
    <div class="chip-group">${Object.entries(CARDIO_TYPES).map(([k, v]) => chipHtml("cd-type", k, v.label, p.type === k)).join("")}</div>
    ${t.where ? `<h3 class="goal-field-label">Where</h3><div class="chip-group">${t.where.map(w => chipHtml("cd-where", w, CARDIO_WHERE_LABELS[w], p.where === w)).join("")}</div>` : ""}
    <h3 class="goal-field-label">Your level</h3>
    <div class="activity-options">${Object.entries(CARDIO_LEVELS).map(([k, v]) => cardioOptHtml("cd-level", k, v.label, v.hint, p.level === k)).join("")}</div>
    <h3 class="goal-field-label">Intensity</h3>
    <div class="chip-group">${Object.entries(CARDIO_INTENSITIES).map(([k, v]) => chipHtml("cd-intensity", k, v, p.intensity === k)).join("")}</div>
    <h3 class="goal-field-label">Goal</h3>
    <div class="activity-options">${Object.entries(CARDIO_GOALS).map(([k, v]) => cardioOptHtml("cd-goal", k, v.label, v.hint, p.goal === k)).join("")}</div>
    <h3 class="goal-field-label">Duration</h3>
    <div class="chip-group">${CARDIO_DURATIONS.map(m => chipHtml("cd-minutes", m, `${m} min`, p.minutes === m)).join("")}</div>
    <button type="button" id="cd-build-btn" class="primary-btn">Build Cardio Session</button>
    <button type="button" id="cd-quicklog-btn" class="primary-btn secondary">Log Cardio I've Already Done</button>
    <h3 class="section-heading">Recent cardio</h3>
    <div id="cd-recent">${recent.length ? recent.map(h => `<div class="saved-item"><div><div class="title">${h.title}</div><div class="sub">${new Date(h.finishedAt).toLocaleDateString()} · ${h.cardio.minutes} min · ~${h.cardio.kcal} kcal${h.cardio.distanceKm ? ` · ${h.cardio.distanceKm} km` : ""}</div></div><button type="button" class="saved-delete-btn" data-cd-delete="${h.id}" aria-label="Delete session">Delete</button></div>`).join("")
      : `<div class="empty-state">No cardio logged yet.<br>Build a session or log one you've done.</div>`}</div>`;
}

function cardioPartHtml(pt, type, where, level) {
  return `<div class="cd-part cd-${pt.kind}">
    <div class="cd-part-top"><span class="cd-part-label">${pt.label}</span><span class="cd-part-time">${fmtSec(pt.sec)}</span></div>
    <div class="cd-part-cue">${cardioStepCue(pt, { type, where, level })}</div>
    <div class="cd-part-effort">Effort ${pt.rpe}/10 (${RPE_WORDS[pt.rpe]}) · ${cardioZoneText(pt.rpe)}</div>
  </div>`;
}

function renderCardioSession() {
  const s = cardioSession, p = s.params, t = CARDIO_TYPES[p.type];
  const sub = [CARDIO_LEVELS[p.level].label, CARDIO_INTENSITIES[p.intensity], t.where ? CARDIO_WHERE_LABELS[p.where] : null].filter(Boolean).join(" · ");
  const workSteps = s.steps.filter(x => x.kind === "work").length;
  const weightNote = getNutritionTargets().profile ? "" : `<div class="mp-hint">Calories assume 75 kg. Set your weight in Food › Goals for a better estimate.</div>`;
  document.getElementById("cardio-body").innerHTML = `
    <button type="button" class="saved-folder-back" data-cd-nav="setup">‹ Change settings</button>
    <h2 class="mp-title">${cardioSessionTitle(s)}</h2>
    <p class="mp-intro">${sub}</p>
    <div class="cd-stats">
      <div class="cd-stat"><b>${Math.round(s.totalSec / 60)}</b><span>min</span></div>
      <div class="cd-stat"><b>~${s.kcal}</b><span>kcal</span></div>
      <div class="cd-stat"><b>${workSteps || "–"}</b><span>${workSteps ? "hard efforts" : "steady"}</span></div>
    </div>
    ${weightNote}
    ${s.blocks.map(b => `<div class="card cd-block">
      <div class="cd-block-title">${b.title}${b.reps > 1 ? ` <span class="cd-reps">× ${b.reps}</span>` : ""}</div>
      ${b.parts.map(pt => cardioPartHtml(pt, p.type, p.where, p.level)).join("")}
    </div>`).join("")}
    <div class="mp-hint">Effort scale: 3 = easy chat, 5 = you can talk in sentences, 7 = only a few words, 9 = can't talk. Go by feel if you don't have a heart-rate monitor.</div>
    <button type="button" id="cd-start-btn" class="primary-btn">Start Session</button>
    ${p.type === "hiit" ? `<button type="button" id="cd-shuffle-btn" class="primary-btn secondary">Shuffle Moves</button>` : ""}
    <button type="button" id="cd-logplan-btn" class="primary-btn secondary">Log It Without the Timer</button>`;
}

// ---------- timer ----------
let cardioAudio = null;
function cardioBeep(freq = 880, ms = 160) {
  try {
    cardioAudio = cardioAudio || new (window.AudioContext || window.webkitAudioContext)();
    const o = cardioAudio.createOscillator(), g = cardioAudio.createGain();
    o.frequency.value = freq; g.gain.value = 0.15;
    o.connect(g); g.connect(cardioAudio.destination);
    o.start(); o.stop(cardioAudio.currentTime + ms / 1000);
  } catch (e) { /* audio not available */ }
  if (navigator.vibrate) navigator.vibrate(ms);
}
function startCardioTimer() {
  cardioRun = { idx: 0, stepEndsAt: Date.now() + cardioSession.steps[0].sec * 1000, paused: false, remaining: 0, spent: 0, lastBeep: null, timer: null };
  cardioView = "timer";
  cardioBeep(660);
  cardioRun.timer = setInterval(cardioTick, 250);
  renderCardioTimer();
}
function cardioStepRemaining() {
  if (!cardioRun) return 0;
  return cardioRun.paused ? cardioRun.remaining : (cardioRun.stepEndsAt - Date.now()) / 1000;
}
function cardioAdvance(skipped) {
  const steps = cardioSession.steps;
  const step = steps[cardioRun.idx];
  cardioRun.spent += skipped ? Math.max(0, step.sec - Math.max(0, cardioStepRemaining())) : step.sec;
  cardioRun.idx++;
  if (cardioRun.idx >= steps.length) return finishCardioTimer();
  const next = steps[cardioRun.idx];
  if (cardioRun.paused) cardioRun.remaining = next.sec;
  else cardioRun.stepEndsAt = Date.now() + next.sec * 1000;
  cardioBeep(next.kind === "work" ? 990 : 660, 220);
  renderCardioTimer();
}
function cardioTick() {
  if (!cardioRun || cardioRun.paused) return;
  const rem = cardioStepRemaining();
  if (rem <= 0) return cardioAdvance(false);
  const whole = Math.ceil(rem);
  if (whole <= 3 && cardioRun.lastBeep !== `${cardioRun.idx}-${whole}`) { cardioRun.lastBeep = `${cardioRun.idx}-${whole}`; cardioBeep(520, 90); }
  updateCardioTimerClock();
}
function stopCardioTimer() {
  if (cardioRun && cardioRun.timer) clearInterval(cardioRun.timer);
}
function finishCardioTimer(early) {
  if (!cardioRun) return;
  if (early) {
    const step = cardioSession.steps[cardioRun.idx];
    if (step) cardioRun.spent += Math.max(0, step.sec - Math.max(0, cardioStepRemaining()));
  }
  stopCardioTimer();
  const minutes = Math.max(1, Math.round(cardioRun.spent / 60));
  cardioRun = null;
  openCardioLog({ fromTimer: true, minutes });
}
function updateCardioTimerClock() {
  const clock = document.getElementById("cd-clock");
  if (!clock || !cardioRun) return;
  const rem = cardioStepRemaining();
  clock.textContent = fmtClock(rem);
  const steps = cardioSession.steps;
  const doneSec = steps.slice(0, cardioRun.idx).reduce((s, x) => s + x.sec, 0) + (steps[cardioRun.idx].sec - Math.max(0, rem));
  const bar = document.getElementById("cd-progress-fill");
  if (bar) bar.style.width = `${Math.min(100, doneSec / cardioSession.totalSec * 100)}%`;
  const left = document.getElementById("cd-time-left");
  if (left) left.textContent = `${fmtClock(cardioSession.totalSec - doneSec)} left`;
}
function renderCardioTimer() {
  const s = cardioSession, p = s.params, step = s.steps[cardioRun.idx], next = s.steps[cardioRun.idx + 1];
  const cue = cardioStepCue(step, p);
  document.getElementById("cardio-body").innerHTML = `
    <div class="cd-timer cd-${step.kind}">
      <div class="cd-timer-block">${step.block}${step.reps > 1 ? ` · ${step.rep} of ${step.reps}` : ""}</div>
      <div class="cd-timer-label" id="cd-step-label">${step.label}</div>
      <div class="cd-timer-clock" id="cd-clock">${fmtClock(cardioStepRemaining())}</div>
      <div class="cd-timer-cue">${cue}</div>
      <div class="cd-timer-effort">Effort ${step.rpe}/10 · ${cardioZoneText(step.rpe)}</div>
      <div class="cd-progress"><div class="cd-progress-fill" id="cd-progress-fill"></div></div>
      <div class="cd-timer-meta"><span>Step ${cardioRun.idx + 1} of ${s.steps.length}</span><span id="cd-time-left"></span></div>
      <div class="cd-timer-next">${next ? `Next: ${next.label} · ${fmtSec(next.sec)}` : "Last step — nearly done!"}</div>
    </div>
    <div class="cd-timer-btns">
      <button type="button" id="cd-pause-btn" class="primary-btn">${cardioRun.paused ? "Resume" : "Pause"}</button>
      <button type="button" id="cd-skip-btn" class="primary-btn secondary">Skip ›</button>
    </div>
    <button type="button" id="cd-end-btn" class="primary-btn secondary">End &amp; Log</button>`;
  updateCardioTimerClock();
}

// ---------- logging ----------
function openCardioLog({ fromTimer = false, minutes = null, quick = false } = {}) {
  const p = cardioSession && !quick ? cardioSession.params : (cardioPrefs || getCardioPrefs());
  const planned = cardioSession && !quick ? cardioSession : null;
  cardioLogDraft = {
    type: p.type, intensity: p.intensity, goal: p.goal, distanceKm: "",
    minutes: minutes || (planned ? Math.round(planned.totalSec / 60) : p.minutes),
    // planned sessions keep their real mix of efforts; quick logs use the intensity's typical effort
    kcalPerMin: planned ? planned.kcal / (planned.totalSec / 60) : null,
    title: planned ? cardioSessionTitle(planned) : null,
    fromTimer, quick
  };
  cardioView = "log";
  renderCardioLog();
}
function cardioDraftKcal(d = cardioLogDraft) {
  const per = d.kcalPerMin ?? cardioKcal(d.type, CARDIO_INTENSITY_RPE[d.intensity] || 6, 60);
  return Math.round(per * (d.minutes || 0));
}
function renderCardioLog() {
  const d = cardioLogDraft;
  document.getElementById("cardio-body").innerHTML = `
    <button type="button" class="saved-folder-back" data-cd-nav="${d.quick ? "setup" : "session"}">‹ Back</button>
    <h2 class="mp-title">${d.fromTimer ? "Nice work!" : "Log cardio"}</h2>
    <p class="mp-intro">${d.fromTimer ? "Check the details, then save it to your history." : "Add a session you did — it counts towards your week and your Recovery."}</p>
    ${d.quick ? `<h3 class="goal-field-label">Type</h3><div class="chip-group">${Object.entries(CARDIO_TYPES).map(([k, v]) => chipHtml("cdl-type", k, v.label, d.type === k)).join("")}</div>
    <h3 class="goal-field-label">How hard was it?</h3><div class="chip-group">${Object.entries(CARDIO_INTENSITIES).map(([k, v]) => chipHtml("cdl-intensity", k, v, d.intensity === k)).join("")}</div>` : ""}
    <h3 class="goal-field-label">Minutes</h3>
    <input type="number" id="cdl-minutes" class="mp-input" inputmode="numeric" min="1" max="600" value="${d.minutes}">
    <h3 class="goal-field-label">Distance (km, optional)</h3>
    <input type="number" id="cdl-distance" class="mp-input" inputmode="decimal" min="0" step="0.1" value="${d.distanceKm}">
    <div class="cd-kcal-line">Calories burned: <b id="cdl-kcal">~${cardioDraftKcal()}</b> kcal</div>
    <button type="button" id="cdl-save-btn" class="primary-btn">Save Session</button>
    <button type="button" id="cdl-discard-btn" class="primary-btn secondary">Discard</button>`;
}
function saveCardioLog() {
  const d = cardioLogDraft;
  if (!d || !(d.minutes > 0)) return;
  recordCardio({ type: d.type, minutes: d.minutes, kcal: cardioDraftKcal(d), distanceKm: parseFloat(d.distanceKm) || null, intensity: d.intensity, goal: d.goal, title: d.quick ? null : d.title });
  cardioLogDraft = null;
  cardioSession = null;
  cardioView = "setup";
  renderCardio();
}

document.getElementById("cardio-body").addEventListener("click", e => {
  const el = e.target.closest("button");
  if (!el) return;
  const d = el.dataset;
  const setPref = (key, val) => { cardioPrefs[key] = val; setCardioPrefs(cardioPrefs); renderCardioSetup(); };
  if (d.cdType) return setPref("type", d.cdType);
  if (d.cdWhere) return setPref("where", d.cdWhere);
  if (d.cdLevel) return setPref("level", d.cdLevel);
  if (d.cdIntensity) return setPref("intensity", d.cdIntensity);
  if (d.cdGoal) return setPref("goal", d.cdGoal);
  if (d.cdMinutes) return setPref("minutes", parseInt(d.cdMinutes, 10));
  if (d.cdDelete) {
    if (!confirm("Delete this cardio session?")) return;
    setWorkoutHistory(getWorkoutHistory().filter(h => h.id !== d.cdDelete));
    return renderCardioSetup();
  }
  if (d.cdNav) { cardioView = d.cdNav; return renderCardio(); }
  if (d.cdlType || d.cdlIntensity) {
    if (d.cdlType) cardioLogDraft.type = d.cdlType;
    if (d.cdlIntensity) cardioLogDraft.intensity = d.cdlIntensity;
    return renderCardioLog();
  }
  switch (el.id) {
    case "cd-build-btn": cardioSession = buildCardioSession(cardioPrefs); cardioView = "session"; return renderCardio();
    case "cd-shuffle-btn": cardioSession = buildCardioSession(cardioSession.params); return renderCardioSession();
    case "cd-quicklog-btn": return openCardioLog({ quick: true });
    case "cd-logplan-btn": return openCardioLog();
    case "cd-start-btn": return startCardioTimer();
    case "cd-pause-btn":
      if (cardioRun.paused) { cardioRun.stepEndsAt = Date.now() + cardioRun.remaining * 1000; cardioRun.paused = false; }
      else { cardioRun.remaining = cardioStepRemaining(); cardioRun.paused = true; }
      return renderCardioTimer();
    case "cd-skip-btn": return cardioAdvance(true);
    case "cd-end-btn":
      if (!confirm("End the session and log what you've done?")) return;
      return finishCardioTimer(true);
    case "cdl-save-btn": return saveCardioLog();
    case "cdl-discard-btn":
      cardioLogDraft = null; cardioView = cardioSession ? "session" : "setup"; return renderCardio();
  }
});
document.getElementById("cardio-body").addEventListener("input", e => {
  if (!cardioLogDraft) return;
  if (e.target.id === "cdl-minutes") cardioLogDraft.minutes = parseInt(e.target.value, 10) || 0;
  else if (e.target.id === "cdl-distance") cardioLogDraft.distanceKm = e.target.value;
  else return;
  const k = document.getElementById("cdl-kcal");
  if (k) k.textContent = `~${cardioDraftKcal()}`;
});

document.querySelectorAll("[data-goto-cardio]").forEach(b => b.addEventListener("click", () => showTab("cardio-screen")));

// ============================================================
// BEER PLANNER (v38) — plan the week's beers, see the calories and
// balance them with a smaller food target and/or extra cardio.
// ============================================================
const BEER_PLAN_KEY = "beerPlan";
// kcal and carbs per 100 ml, typical Australian beers
const BEER_TYPES = {
  zero: { label: "Zero alcohol", abv: 0.5, kcal100: 17, carbs100: 3.5 },
  light: { label: "Light", abv: 2.7, kcal100: 27, carbs100: 2.3 },
  mid: { label: "Mid-strength", abv: 3.5, kcal100: 31, carbs100: 2.5 },
  full: { label: "Full-strength", abv: 4.8, kcal100: 39, carbs100: 2.9 },
  craft: { label: "Craft / IPA", abv: 6, kcal100: 55, carbs100: 4.5 }
};
const BEER_SIZES = {
  middy: { label: "Middy", ml: 285 },
  bottle: { label: "Bottle", ml: 330 },
  can: { label: "Can / stubby", ml: 375 },
  schooner: { label: "Schooner", ml: 425 },
  pint: { label: "Pint", ml: 570 }
};
const BEER_BALANCE = { food: { label: "Eat less", share: 1 }, mix: { label: "Half & half", share: 0.5 }, cardio: { label: "Do cardio", share: 0 } };
const BEER_CARDIO_TYPES = ["walk", "run", "cycle", "row", "swim", "hiit"];
const STD_DRINKS_WEEK_MAX = 10, STD_DRINKS_DAY_MAX = 4; // Australian guidelines
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Week keys use the same UTC YYYY-MM-DD keys as the food diary
function keyAddDays(key, n) {
  const d = new Date(key + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStartKey(key = todayKey()) {
  const dow = (new Date(key + "T00:00:00Z").getUTCDay() + 6) % 7;
  return keyAddDays(key, -dow);
}
function beerDayIndex(key) { return (new Date(key + "T00:00:00Z").getUTCDay() + 6) % 7; }

function defaultBeerPlan() {
  return { weekStart: weekStartKey(), type: "full", size: "can", counts: [0, 0, 0, 0, 0, 0, 0], logged: [], balance: "mix", cardioType: "walk", applyToDiary: true };
}
function getBeerPlan() {
  let p;
  try { p = JSON.parse(localStorage.getItem(BEER_PLAN_KEY) || "null"); } catch (e) { p = null; }
  if (!p) return defaultBeerPlan();
  // a new week starts empty but keeps your beer, size and balance settings
  if (p.weekStart !== weekStartKey()) p = { ...defaultBeerPlan(), type: p.type, size: p.size, balance: p.balance, cardioType: p.cardioType, applyToDiary: p.applyToDiary };
  return { ...defaultBeerPlan(), ...p };
}
function setBeerPlan(p) { localStorage.setItem(BEER_PLAN_KEY, JSON.stringify(p)); }

function beerOne(plan) {
  const t = BEER_TYPES[plan.type] || BEER_TYPES.full, ml = (BEER_SIZES[plan.size] || BEER_SIZES.can).ml;
  return { kcal: t.kcal100 * ml / 100, carbs: t.carbs100 * ml / 100, std: ml * t.abv / 100 * 0.789 / 10, ml };
}
function beerPlanStats(plan = getBeerPlan()) {
  const one = beerOne(plan);
  const beers = plan.counts.reduce((s, n) => s + n, 0);
  const kcal = Math.round(beers * one.kcal);
  const share = (BEER_BALANCE[plan.balance] || BEER_BALANCE.mix).share;
  const foodKcal = Math.round(kcal * share);
  const cardioKcalTarget = kcal - foodKcal;
  const perMin = cardioKcal(plan.cardioType, 6, 60);
  const cardioMinutes = cardioKcalTarget > 0 ? Math.ceil(cardioKcalTarget / perMin) : 0;
  const sessions = cardioMinutes ? Math.max(1, Math.ceil(cardioMinutes / 45)) : 0;
  return {
    one, beers, kcal, std: beers * one.std,
    dayStd: plan.counts.map(n => n * one.std),
    dailyCut: Math.round(foodKcal / 7), foodKcal, cardioKcalTarget, cardioMinutes, sessions,
    sessionMinutes: sessions ? Math.ceil(cardioMinutes / sessions) : 0
  };
}
// How a food-diary day's calorie target changes with the beer plan:
// food is trimmed every day, and the day's planned beers are added on top so
// logging them doesn't put you "over". Net over the week = your normal target.
function beerDiaryAdjustment(key) {
  const plan = getBeerPlan();
  if (!plan.applyToDiary || weekStartKey(key) !== plan.weekStart) return null;
  const s = beerPlanStats(plan);
  if (!s.beers) return null;
  const beerKcal = Math.round(plan.counts[beerDayIndex(key)] * s.one.kcal);
  return { cut: s.dailyCut, beerKcal, delta: beerKcal - s.dailyCut };
}
function beerAdjNoteText(adj) {
  if (!adj) return "";
  return `Beer plan: −${adj.cut} kcal food${adj.beerKcal ? ` · +${adj.beerKcal} kcal for today's beers` : ""}`;
}
function logBeersToDiary(dayIdx) {
  const plan = getBeerPlan();
  const n = plan.counts[dayIdx];
  if (!n) return;
  const one = beerOne(plan), t = BEER_TYPES[plan.type], size = BEER_SIZES[plan.size];
  const key = keyAddDays(plan.weekStart, dayIdx);
  const entries = getFoodLogFor(key);
  entries.unshift({
    name: `${t.label} beer × ${n}`, brand: `${size.label} ${size.ml} ml · ${(n * one.std).toFixed(1)} standard drinks`,
    calories: Math.round(n * one.kcal), protein: Math.round(n * one.ml * 0.003 * 10) / 10, carbs: Math.round(n * one.carbs), fat: 0,
    beer: true, loggedAt: new Date().toISOString()
  });
  saveFoodLogFor(key, entries);
  plan.logged = Array.from(new Set([...(plan.logged || []), dayIdx]));
  setBeerPlan(plan);
}

function renderBeerPlanner() {
  const body = document.getElementById("beer-body");
  if (!body) return;
  const plan = getBeerPlan();
  const s = beerPlanStats(plan);
  const today = todayKey(), todayIdx = plan.weekStart === weekStartKey(today) ? beerDayIndex(today) : -1;
  const T = getNutritionTargets().calories;
  const overWeek = s.std > STD_DRINKS_WEEK_MAX + 0.05;
  const overDays = s.dayStd.map((v, i) => v > STD_DRINKS_DAY_MAX + 0.05 ? i : -1).filter(i => i >= 0);
  const ct = CARDIO_TYPES[plan.cardioType];
  const cardioDone = cardioWeekStats().kcal;
  const lightSave = plan.type !== "light" && plan.type !== "zero" ? Math.round(s.kcal - s.beers * BEER_TYPES.light.kcal100 * s.one.ml / 100) : 0;
  const zeroSave = plan.type !== "zero" ? Math.round(Math.floor(s.beers / 2) * (s.one.kcal - BEER_TYPES.zero.kcal100 * s.one.ml / 100)) : 0;
  const bigDays = plan.counts.map((n, i) => s.dayStd[i] >= 4 - 0.05 && n ? i : -1).filter(i => i >= 0);
  const runEquiv = Math.round(s.kcal / cardioKcal("run", 6, 60));

  body.innerHTML = `
    <p class="mp-intro">Plan your beers for the week. You'll see the calories, and how to balance them with food and cardio.</p>
    <h3 class="goal-field-label">Beer</h3>
    <div class="chip-group">${Object.entries(BEER_TYPES).map(([k, v]) => chipHtml("bp-type", k, `${v.label} <small>${v.abv}%</small>`, plan.type === k)).join("")}</div>
    <h3 class="goal-field-label">Size</h3>
    <div class="chip-group">${Object.entries(BEER_SIZES).map(([k, v]) => chipHtml("bp-size", k, `${v.label} <small>${v.ml} ml</small>`, plan.size === k)).join("")}</div>
    <div class="mp-hint">One ${BEER_SIZES[plan.size].label.toLowerCase()} = ~${Math.round(s.one.kcal)} kcal · ${s.one.std.toFixed(1)} standard drinks</div>

    <h3 class="goal-field-label">This week</h3>
    <div class="card bp-week">${plan.counts.map((n, i) => {
      const key = keyAddDays(plan.weekStart, i);
      const d = new Date(key + "T00:00:00Z");
      const over = overDays.includes(i);
      const canLog = n > 0 && i <= todayIdx;
      const logged = (plan.logged || []).includes(i);
      return `<div class="bp-day${i === todayIdx ? " today" : ""}${over ? " over" : ""}">
        <div class="bp-day-name"><b>${DAY_NAMES[i]}</b><span>${d.getUTCDate()} ${d.toLocaleString("en-AU", { month: "short", timeZone: "UTC" })}</span></div>
        <div class="bp-day-info">${n ? `${Math.round(n * s.one.kcal)} kcal · ${s.dayStd[i].toFixed(1)} std` : `<span class="bp-none">No beers</span>`}
          ${canLog ? `<button type="button" class="bp-log-btn${logged ? " done" : ""}" data-bp-log="${i}">${logged ? "Logged ✓" : "Log to diary"}</button>` : ""}</div>
        <div class="bp-stepper">
          <button type="button" class="bp-step" data-bp-dec="${i}" aria-label="One less on ${DAY_NAMES[i]}"${n ? "" : " disabled"}>−</button>
          <span class="bp-count" data-bp-count="${i}">${n}</span>
          <button type="button" class="bp-step" data-bp-inc="${i}" aria-label="One more on ${DAY_NAMES[i]}">+</button>
        </div>
      </div>`;
    }).join("")}</div>

    <div class="card bp-summary">
      <div class="bp-total"><b id="bp-total-kcal">${s.kcal.toLocaleString()}</b> kcal from <b>${s.beers}</b> beer${s.beers === 1 ? "" : "s"}</div>
      <div class="mp-hint">${s.std.toFixed(1)} standard drinks this week${s.beers ? ` · about ${runEquiv} min of running to burn off` : ""}</div>
      <div class="bp-guide${overWeek || overDays.length ? " warn" : ""}">${overWeek || overDays.length
        ? `Heads up: ${[overWeek ? `${s.std.toFixed(1)} standard drinks is over the 10-a-week guideline` : "", overDays.length ? `${overDays.map(i => DAY_NAMES[i]).join(", ")} ${overDays.length === 1 ? "is" : "are"} over 4 on one day` : ""].filter(Boolean).join(", and ")}. `
        : ""}Australian guidelines: no more than 10 standard drinks a week and no more than 4 on any one day.</div>
    </div>

    ${s.beers ? `
    <h3 class="goal-field-label">Balance it with</h3>
    <div class="chip-group">${Object.entries(BEER_BALANCE).map(([k, v]) => chipHtml("bp-balance", k, v.label, plan.balance === k)).join("")}</div>
    ${s.foodKcal ? `<div class="card bp-offset">
      <div class="bp-offset-title">Food</div>
      <div class="bp-offset-main">Eat <b>${s.dailyCut} kcal less</b> each day</div>
      <div class="mp-hint">${T - s.dailyCut} kcal of food a day instead of ${T}, plus your beers on the days you drink them.</div>
      <button type="button" class="chip${plan.applyToDiary ? " selected" : ""}" data-bp-apply="1">${plan.applyToDiary ? "✓ " : ""}Use this in my Food Diary</button>
    </div>` : ""}
    ${s.cardioKcalTarget ? `<div class="card bp-offset">
      <div class="bp-offset-title">Cardio</div>
      <div class="chip-group bp-cardio-types">${BEER_CARDIO_TYPES.map(k => chipHtml("bp-cardio", k, CARDIO_TYPES[k].label.replace(" (no equipment)", ""), plan.cardioType === k)).join("")}</div>
      <div class="bp-offset-main"><b>~${s.cardioMinutes} min</b> of moderate ${{ walk: "walking", run: "running", cycle: "cycling", row: "rowing", swim: "swimming", hiit: "HIIT" }[plan.cardioType]} this week</div>
      <div class="mp-hint">${s.sessions > 1 ? `e.g. ${s.sessions} × ${s.sessionMinutes} min sessions` : `One ${s.sessionMinutes}-min session`} to burn ~${s.cardioKcalTarget} kcal. Cardio logged this week: ~${cardioDone} kcal.</div>
      <div class="rec-bar"><div class="rec-bar-fill fresh" style="width:${Math.min(100, Math.round(cardioDone / s.cardioKcalTarget * 100))}%"></div></div>
      <button type="button" id="bp-cardio-btn" class="primary-btn">Build a ${beerSessionMinutes(s.sessionMinutes)}-min ${ct.label.replace(" (no equipment)", "")} Session</button>
    </div>` : ""}
    <h3 class="goal-field-label">Tips</h3>
    <ul class="bp-tips">
      ${lightSave > 0 ? `<li>Switching to light beer saves ~${lightSave} kcal this week.</li>` : ""}
      ${zeroSave > 0 && s.beers >= 2 ? `<li>Swapping every second beer for a zero-alcohol one saves ~${zeroSave} kcal.</li>` : ""}
      ${bigDays.length ? `<li>After ${bigDays.map(i => DAY_NAMES[i]).join(", ")}: go easy the next day (a walk or mobility, not heavy lifting). Alcohol slows recovery.</li>` : ""}
      <li>Eat a protein-rich meal before drinking and have water between beers.</li>
    </ul>` : `<div class="empty-state">Tap + on a day to plan your beers.</div>`}
    ${s.beers ? `<button type="button" id="bp-clear-btn" class="primary-btn secondary">Clear This Week</button>` : ""}`;
}
// sessions are built from the Cardio section's duration options
function beerSessionMinutes(m) {
  return CARDIO_DURATIONS.reduce((best, d) => Math.abs(d - m) < Math.abs(best - m) ? d : best, CARDIO_DURATIONS[0]);
}

document.getElementById("beer-body").addEventListener("click", e => {
  const el = e.target.closest("button");
  if (!el) return;
  const d = el.dataset, plan = getBeerPlan();
  const save = () => { setBeerPlan(plan); renderBeerPlanner(); };
  if (d.bpType) { plan.type = d.bpType; return save(); }
  if (d.bpSize) { plan.size = d.bpSize; return save(); }
  if (d.bpBalance) { plan.balance = d.bpBalance; return save(); }
  if (d.bpCardio) { plan.cardioType = d.bpCardio; return save(); }
  if (d.bpApply) { plan.applyToDiary = !plan.applyToDiary; return save(); }
  if (d.bpInc !== undefined) { const i = +d.bpInc; plan.counts[i] = Math.min(30, plan.counts[i] + 1); plan.logged = (plan.logged || []).filter(x => x !== i); return save(); }
  if (d.bpDec !== undefined) { const i = +d.bpDec; plan.counts[i] = Math.max(0, plan.counts[i] - 1); plan.logged = (plan.logged || []).filter(x => x !== i); return save(); }
  if (d.bpLog !== undefined) {
    if ((plan.logged || []).includes(+d.bpLog) && !confirm("Already logged. Log these beers again?")) return;
    logBeersToDiary(+d.bpLog); return renderBeerPlanner();
  }
  if (el.id === "bp-clear-btn") {
    if (!confirm("Clear this week's beer plan?")) return;
    plan.counts = [0, 0, 0, 0, 0, 0, 0]; plan.logged = []; return save();
  }
  if (el.id === "bp-cardio-btn") {
    const s = beerPlanStats(plan);
    cardioPrefs = { ...getCardioPrefs(), type: plan.cardioType, minutes: beerSessionMinutes(s.sessionMinutes), goal: "fatburn", intensity: "moderate" };
    if (CARDIO_TYPES[plan.cardioType].where && !CARDIO_TYPES[plan.cardioType].where.includes(cardioPrefs.where)) cardioPrefs.where = CARDIO_TYPES[plan.cardioType].where[0];
    setCardioPrefs(cardioPrefs);
    cardioSession = buildCardioSession(cardioPrefs);
    cardioView = "session";
    showTab("cardio-screen");
  }
});

document.getElementById("beer-btn").addEventListener("click", () => showTab("beer-screen"));
document.getElementById("beer-back-btn").addEventListener("click", () => showTab("nutrition-screen"));

// ============================================================
// init — keep this LAST: updateHomeStats reads constants from every
// module above (cardio, beer planner), which don't exist until defined.
// ============================================================
updateHomeStats();
