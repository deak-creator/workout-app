let EXERCISES = [];
let currentWorkout = null;
let currentPlan = null;
let lastParams = null;
let activeWeekIndex = 0;
let activePlanDayIndex = null; // null = jump to the first unfinished day

const ALL_EQUIPMENT = ["bodyweight", "dumbbells", "bands", "kettlebell", "pullup bar", "barbell", "cable machine", "bench"];
const HOME_EQUIPMENT = ["bodyweight", "dumbbells", "bands", "kettlebell", "pullup bar"];
const GYM_EQUIPMENT = ALL_EQUIPMENT; // gyms typically have everything, including home-friendly gear

// At the gym, home-style gear is still allowed but should rarely win: prefer barbell/cable/bench work.
const GYM_EQUIPMENT_BIAS = { barbell: 3, "cable machine": 3, bench: 3, dumbbells: 2.5, kettlebell: 0.5, "pullup bar": 0, bands: -3, bodyweight: -2 };

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
  state.mode = btn.dataset.value;
  document.querySelectorAll(".plan-only").forEach(el => el.hidden = state.mode !== "plan");
  document.querySelectorAll(".quick-only").forEach(el => el.hidden = state.mode === "plan");
  document.getElementById("duration-label").textContent = state.mode === "plan" ? "Minutes per day" : "Duration";
  document.getElementById("generate-btn").textContent = state.mode === "plan" ? "Generate Plan" : "Generate Workout";
});

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
const ROTATION_ORDER = ["strength", "cardio", "fatloss", "strength", "mobility", "cardio", "strength"];

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
  const baseWeights = { strength: 3, cardio: 2, fatloss: 2, mobility: 1 };
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
  const hasBias = Object.values(bias.typeBias).some(v => v !== 0);

  if (daysPerWeek >= 7) {
    // 7 days: six varied sessions + one rest/recovery day
    const order = hasBias ? buildBiasedRotation(6, bias) : ["strength", "cardio", "fatloss", "strength", "mobility", "cardio"];
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

  document.getElementById("wo-plan-pill-text").textContent = `${titleMap[workout.goal]} · ${workout.duration} min`;
  document.getElementById("workout-title").textContent =
    top.length ? top.map(t => titleCase(t.muscle)).join(", ") : titleMap[workout.goal];
  document.getElementById("workout-sub").textContent =
    `${allItems.length} exercises · ${titleCase(workout.difficulty)}`;

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
    title: muscles || titleMap[currentWorkout.goal],
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
function addExerciseCandidates(query) {
  const equipment = lastParams.equipment instanceof Set ? lastParams.equipment : new Set(lastParams.equipment);
  const maxDiff = DIFF_RANK[lastParams.difficulty];
  const inWorkout = new Set(currentWorkout.blocks.flatMap(b => b.items).map(i => i.name));
  const q = query.trim().toLowerCase();
  return EXERCISES.filter(ex =>
    equipment.has(ex.equipment) && DIFF_RANK[ex.difficulty] <= maxDiff && !inWorkout.has(ex.name) &&
    (!q || ex.name.toLowerCase().includes(q) || ex.muscles.some(m => m.includes(q)))
  ).sort((a, b) => {
    const atGym = isGymSession(lastParams);
    return (gymEquipmentBias(b, atGym) - gymEquipmentBias(a, atGym)) || a.name.localeCompare(b.name);
  });
}

function renderAddExerciseList() {
  const listEl = document.getElementById("addex-list");
  const results = addExerciseCandidates(document.getElementById("addex-search").value);
  if (!results.length) {
    listEl.innerHTML = `<div class="empty-state">No matching exercises for your equipment.</div>`;
    return;
  }
  listEl.innerHTML = "";
  results.forEach(ex => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "addex-item";
    btn.innerHTML = `<span class="ex-thumb">${bodySvg(ex.muscles)}</span>
      <span class="addex-text"><span class="addex-name">${ex.name}</span><span class="addex-meta">${ex.muscles.map(titleCase).join(", ")} · ${ex.equipment}</span></span>
      <span class="addex-plus" aria-hidden="true">+</span>`;
    btn.addEventListener("click", () => addExerciseToWorkout(ex));
    listEl.appendChild(btn);
  });
}

function addExerciseToWorkout(ex) {
  const blocks = currentWorkout.blocks;
  const target = blocks.find(b => !/warm|cool/i.test(b.section)) || blocks[blocks.length - 1];
  const sample = target.items.find(i => i._seconds) || {};
  const seconds = sample._seconds || 40;
  const repStyle = (lastParams.promptBias || parseGoalPrompt(lastParams.goalPrompt || "")).repStyle;
  target.items.push({ ...ex, durationLabel: formatSetLabel(ex, seconds, repStyle), _seconds: seconds, _role: "main", _focus: null });
  document.getElementById("addex-modal").hidden = true;
  renderWorkout(currentWorkout);
}

document.getElementById("wo-add-exercise").addEventListener("click", () => {
  if (!currentWorkout) return;
  document.getElementById("addex-search").value = "";
  renderAddExerciseList();
  document.getElementById("addex-modal").hidden = false;
});
document.getElementById("addex-search").addEventListener("input", renderAddExerciseList);
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

function openExerciseDetail(ex, returnTo, onDone) {
  stopRestTimer();
  exDetail = {
    ex, returnTo, onDone,
    scrollY: window.scrollY || 0,
    tab: "log",
    log: ex._log ? JSON.parse(JSON.stringify(ex._log)) : prefilledLog(ex)
  };
  renderExerciseDetail();
  showTab("exercise-screen");
  window.scrollTo(0, 0);
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
  window.scrollTo(0, d.scrollY);
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
    : `${GOAL_TITLES[w.goal] || "Workout"} · ${w.duration} min`;
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
    lastParams = { goal: w.goal, duration: w.duration, difficulty: w.difficulty, equipment: new Set(w.equipment), muscles: new Set() };
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
    const volume = h.exercises.reduce((v, ex) => v + ex.sets.reduce((a, s) => a + (parseFloat(s.reps) || 0) * (parseFloat(s.weight) || 0), 0), 0);
    const item = document.createElement("div");
    item.className = "saved-item rec-history-item";
    item.innerHTML = `
      <div>
        <div class="title">${h.title}</div>
        <div class="sub">${new Date(h.finishedAt).toLocaleDateString()} · ${h.exercises.length} exercises · ${sets} sets${volume ? ` · ${Math.round(volume).toLocaleString()} kg` : ""}</div>
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
  btn.addEventListener("click", () => { savedFolder = btn.dataset.folder; renderSaved(); window.scrollTo(0, 0); });
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
  if (calSubEl) calSubEl.textContent = `${Math.round(totals.calories)} / ${targets.calories} kcal today`;
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
      const target = tile.dataset.presetmode;
      document.querySelectorAll(".mode-btn").forEach(b => {
        const isTarget = b.dataset.value === target;
        b.classList.toggle("selected", isTarget);
        b.setAttribute("aria-selected", isTarget ? "true" : "false");
      });
      state.mode = target;
      document.querySelectorAll(".plan-only").forEach(el => el.hidden = state.mode !== "plan");
  document.querySelectorAll(".quick-only").forEach(el => el.hidden = state.mode === "plan");
      document.getElementById("duration-label").textContent = state.mode === "plan" ? "Minutes per day" : "Duration";
      document.getElementById("generate-btn").textContent = state.mode === "plan" ? "Generate Plan" : "Generate Workout";
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
  "home-screen": "Workout Builder",
  "setup-screen": "Build",
  "workout-screen": "Your Workout",
  "plan-screen": "Your Plan",
  "nutrition-screen": "Nutrition",
  "saved-screen": "Saved",
  "recovery-screen": "Recovery",
  "exercise-screen": "Exercise"
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
  // sync bottom tabbar highlight for screens not directly in tabbar (workout/plan detail views)
  const tabMap = { "setup-screen": "setup-screen", "workout-screen": "setup-screen", "plan-screen": "setup-screen", "exercise-screen": "setup-screen" };
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

// Mifflin-St Jeor BMR -> TDEE -> goal-adjusted calories -> macro split
function calculateTargets({ sex, age, weightKg, heightCm, activityFactor, goalType }) {
  const bmr = sex === "female"
    ? 10 * weightKg + 6.25 * heightCm - 5 * age - 161
    : 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  const tdee = bmr * activityFactor;

  let calories = tdee;
  let proteinPerKg = 1.8;
  let fatPct = 0.25;

  if (goalType === "lose") {
    calories = tdee - 500;
    proteinPerKg = 2.0; // higher protein to preserve muscle in a deficit
    fatPct = 0.25;
  } else if (goalType === "gain") {
    calories = tdee + 300;
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

  return { calories, protein, carbs, fat, goalType };
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
  const targets = getNutritionTargets();

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
const goalModalState = { goalmode: "calculate", nutriGoal: "maintain", sex: "male", activity: "1.375" };

document.querySelectorAll('[data-field="goalmode"], [data-field="nutriGoal"], [data-field="sex"], [data-field="activity"]').forEach(group => {
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
    goalType: goalModalState.nutriGoal
  });
  previewEl.innerHTML = `Target: <strong>${t.calories} kcal</strong><br>Protein <strong>${t.protein}g</strong> · Carbs <strong>${t.carbs}g</strong> · Fat <strong>${t.fat}g</strong>`;
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
      goalType: goalModalState.nutriGoal
    });
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
// init
// ============================================================
updateHomeStats();
