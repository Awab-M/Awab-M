// Camera-action grammar for WorldCrafter, ported from the official
// `worldcrafter/camera.py` (TencentARC/WorldCrafter) so the route preview and
// validation here match what the Space will actually render.
//
// Coordinates: x right, y down, z forward. Poses are camera-to-world 4x4
// matrices stored as nested row arrays: m[row][col].
//
// This module has no dependencies and runs in both the browser and Node.

export const CHUNK_FRAMES = 33;
export const FPS = 16;
export const MAX_TRANSLATION = 5.0;
export const DEFAULT_ORBIT_RADIUS = 2.0;
/** The public Space renders at most this many chunks per request. */
export const SPACE_MAX_CHUNKS = 6;

export const ACTION_FIELDS = {
  forward: ["forward", 1],
  backward: ["forward", -1],
  left: ["right", -1],
  right: ["right", 1],
  up: ["up", 1],
  down: ["up", -1],
  yaw_left: ["yaw", -1],
  yaw_right: ["yaw", 1],
  pitch_up: ["pitch", 1],
  pitch_down: ["pitch", -1],
  orbit_left: ["orbit_yaw", -1],
  orbit_right: ["orbit_yaw", 1],
  orbit_up: ["orbit_pitch", 1],
  orbit_down: ["orbit_pitch", -1],
};

export const ALIASES = {
  f: "forward", b: "backward", l: "left", r: "right",
  yl: "yaw_left", yr: "yaw_right", pu: "pitch_up", pd: "pitch_down",
};

const TRANSLATION_FIELDS = new Set(["forward", "right", "up"]);
const EPS = 1e-12;

// Python float() for the one numeric header; accepts what float() accepts in practice.
function pyFloat(text) {
  const s = text.trim().toLowerCase().replaceAll("_", "");
  if (/^[+-]?(inf|infinity)$/.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(s)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s)) {
    throw new Error(`could not convert string to float: '${text}'`);
  }
  return Number(s);
}

export function parseEvent(event) {
  const match = /^([a-z_]+)([0-9]+(?:\.[0-9]+)?)$/.exec(event.toLowerCase());
  if (!match) throw new Error(`Invalid action '${event}'; use e.g. forward1 or yaw_left30`);
  let [, name, value] = match;
  name = ALIASES[name] ?? name;
  if (!(name in ACTION_FIELDS)) {
    throw new Error(`Unknown action '${name}'; choose from ${Object.keys(ACTION_FIELDS).join(", ")}`);
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error(`Action amount must be finite: ${event}`);
  if (TRANSLATION_FIELDS.has(ACTION_FIELDS[name][0]) && amount > MAX_TRANSLATION) {
    throw new Error(`${event}: translation must not exceed ${MAX_TRANSLATION} per chunk`);
  }
  return [name, amount];
}

/** Expand space/comma-separated actions, xN repetitions, and # comments. */
export function parseActions(text) {
  text = text.replace(/#[^\n]*/g, "").replace(/\s*&\s*/g, "&");
  const events = [];
  for (const token of text.trim().split(/[\s,]+/)) {
    if (!token) continue;
    const [, event, repeat] = /^(.+?)(?:x([1-9][0-9]*))?$/.exec(token.toLowerCase());
    let canonical;
    if (/^reverse(?:_frames)?[1-9][0-9]*$/.test(event)) {
      canonical = event;
    } else {
      const parts = [];
      const axes = new Set();
      for (const component of event.split("&")) {
        const [name] = parseEvent(component);
        const field = ACTION_FIELDS[name][0];
        if (axes.has(field)) throw new Error(`An action may use each axis only once: ${event}`);
        axes.add(field);
        parts.push(name + /[0-9].*/.exec(component)[0]);
      }
      canonical = parts.join("&");
    }
    for (let i = 0; i < Number(repeat || 1); i++) events.push(canonical);
  }
  if (!events.length) throw new Error("Provide at least one camera action");
  return events;
}

const SETTING_CHOICES = {
  dtype: new Set(["float32", "float64"]),
  sampling: new Set(["linear", "smooth_turns"]),
  last_frame: new Set(["exclude", "include"]),
};

/** Read actions and `@setting value` headers. Returns { events, options }. */
export function parseTrajectory(text) {
  const options = {};
  const lines = [];
  for (let line of text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)) {
    line = line.split("#", 1)[0].trim();
    if (line.startsWith("@")) {
      const fields = line.slice(1).split(/\s+/).filter(Boolean);
      if (fields.length === 2 && fields[0] === "orbit_radius" && !lines.length) {
        const radius = pyFloat(fields[1]);
        if (!Number.isFinite(radius) || radius < 0) {
          throw new Error("Orbit radius must be finite and non-negative");
        }
        options.orbit_radius = radius;
        continue;
      }
      if (fields.length !== 2 || !(fields[0] in SETTING_CHOICES) || !SETTING_CHOICES[fields[0]].has(fields[1])) {
        throw new Error(`Invalid trajectory setting: ${line}`);
      }
      if (lines.length) throw new Error("Trajectory settings must precede the actions");
      options[fields[0]] = fields[1];
    } else if (line) {
      lines.push(line);
    }
  }
  return { events: parseActions(lines.join("\n")), options };
}

export function countChunks(events) {
  return events.reduce(
    (sum, event) => sum + (event.startsWith("reverse") ? Number(/[0-9]+$/.exec(event)[0]) : 1),
    0,
  );
}

function makeAction(fields) {
  return { forward: 0, right: 0, yaw: 0, pitch: 0, speed: 1, up: 0, orbit: false, orbit_radius: 0, ...fields };
}

export function actionFromEvent(event, orbitRadius = DEFAULT_ORBIT_RADIUS) {
  const [name, amount] = parseEvent(event);
  const [field, sign] = ACTION_FIELDS[name];
  if (field.startsWith("orbit_")) {
    return makeAction({ [field.slice(6)]: sign * amount, orbit: true, orbit_radius: orbitRadius });
  }
  if (field === "yaw" || field === "pitch") return makeAction({ [field]: sign * amount });
  return makeAction({ [field]: sign, speed: amount });
}

function validateAction(a) {
  const values = [a.forward, a.right, a.up, a.yaw, a.pitch];
  if (![...values, a.speed].every(Number.isFinite)) throw new Error("Control values must be finite");
  if (values.filter((v) => v !== 0).length > 1) {
    throw new Error("Only one movement or rotation may be active per chunk");
  }
  if (!Number.isFinite(a.orbit_radius) || a.orbit_radius < 0) {
    throw new Error("Orbit radius must be finite and non-negative");
  }
}

// ---- small linear-algebra helpers (3x3 / 4x4 nested arrays) ----------------

const eye4 = () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const clone4 = (m) => m.map((row) => row.slice());
const getR = (m) => [m[0].slice(0, 3), m[1].slice(0, 3), m[2].slice(0, 3)];
const getT = (m) => [m[0][3], m[1][3], m[2][3]];
function setR(m, R) { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] = R[i][j]; }
function setT(m, t) { for (let i = 0; i < 3; i++) m[i][3] = t[i]; }
function mul3(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  }
  return out;
}
const col = (R, j) => [R[0][j], R[1][j], R[2][j]];
const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const radians = (deg) => (deg * Math.PI) / 180;

export function rotationY(degrees) {
  const a = radians(degrees), c = Math.cos(a), s = Math.sin(a);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}

export function rotationX(degrees) {
  const a = radians(degrees), c = Math.cos(a), s = Math.sin(a);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

function horizontalDirection(R, forward) {
  let axis = col(R, forward ? 2 : 0);
  axis[1] = 0;
  let n = norm(axis);
  if (n < 1e-8) {
    // Keep a horizontal heading when looking straight up or down.
    const other = col(R, forward ? 0 : 2);
    axis = [-other[2], 0, other[0]];
    if (!forward) axis = axis.map((v) => -v);
    n = norm(axis);
  }
  return axis.map((v) => v / n);
}

const arange = (n) => Array.from({ length: n }, (_, i) => i / n);
const linspace = (n) => Array.from({ length: n }, (_, i) => i / (n - 1));

function sampleChunk(start, action, fractions = arange(CHUNK_FRAMES)) {
  validateAction(action);
  const poses = fractions.map(() => clone4(start));
  const end = clone4(start);
  const startR = getR(start);
  const startT = getT(start);
  if (action.yaw || action.pitch) {
    const rotated = (f) => (action.yaw ? mul3(rotationY(action.yaw * f), startR) : mul3(startR, rotationX(action.pitch * f)));
    fractions.forEach((f, i) => setR(poses[i], rotated(f)));
    setR(end, rotated(1.0));
    if (action.orbit && action.orbit_radius) {
      const radius = action.orbit_radius;
      const angle = radians(Math.abs(action.yaw || action.pitch));
      if (radius * angle > MAX_TRANSLATION + EPS) {
        throw new Error("Orbit arc length must not exceed 5 per chunk; reduce radius or angle");
      }
      const z0 = col(startR, 2);
      const center = startT.map((v, k) => v + radius * z0[k]);
      const onCircle = (m) => { const z = col(getR(m), 2); setT(m, center.map((c, k) => c - radius * z[k])); };
      poses.forEach(onCircle);
      if (fractions[0] === 0) setT(poses[0], startT);
      onCircle(end);
    }
  } else {
    let direction;
    if (action.up) direction = [0, -action.up, 0];
    else if (action.forward) direction = horizontalDirection(startR, true).map((v) => action.forward * v);
    else direction = horizontalDirection(startR, false).map((v) => action.right * v);
    const delta = direction.map((v) => action.speed * v);
    if (norm(delta) > MAX_TRANSLATION + EPS) {
      throw new Error(`Translation must not exceed ${MAX_TRANSLATION} per chunk`);
    }
    fractions.forEach((f, i) => setT(poses[i], startT.map((v, k) => v + f * delta[k])));
    setT(end, startT.map((v, k) => v + delta[k]));
  }
  return { poses, end };
}

function sampleEvent(start, event, fractions, orbitRadius = DEFAULT_ORBIT_RADIUS) {
  const components = event.split("&");
  if (components.length === 1) return sampleChunk(start, actionFromEvent(event, orbitRadius), fractions).poses;
  if (components.some((part) => part.startsWith("orbit_"))) throw new Error("Use orbit as a separate action");
  const poses = fractions.map(() => clone4(start));
  const startT = getT(start);
  const delta = [0, 0, 0];
  for (const component of components) {
    const action = actionFromEvent(component);
    if (action.yaw) {
      fractions.forEach((f, i) => setR(poses[i], mul3(rotationY(action.yaw * f), getR(poses[i]))));
    } else if (action.pitch) {
      fractions.forEach((f, i) => setR(poses[i], mul3(getR(poses[i]), rotationX(action.pitch * f))));
    } else {
      const { end } = sampleChunk(start, action);
      const endT = getT(end);
      for (let k = 0; k < 3; k++) delta[k] += endT[k] - startT[k];
    }
  }
  if (norm(delta) > MAX_TRANSLATION + EPS) {
    throw new Error(`${event}: combined translation must not exceed ${MAX_TRANSLATION} per chunk`);
  }
  fractions.forEach((f, i) => setT(poses[i], startT.map((v, k) => v + f * delta[k])));
  return poses;
}

function sampleCurve(start, event, tangentStart, tangentEnd, times, orbitRadius) {
  let fractions = times;
  if (tangentStart !== null) {
    fractions = times.map((t) => -2 * t ** 3 + 3 * t ** 2
      + (t ** 3 - 2 * t ** 2 + t) * tangentStart
      + (t ** 3 - t ** 2) * tangentEnd);
  }
  return sampleEvent(start, event, fractions, orbitRadius);
}

/**
 * Build the global c2w trajectory for parsed events.
 * Returns { camera: Mat4[], records: {chunk_index, event, logical_start_c2w, logical_end_c2w}[] }.
 */
export function buildTrajectory(events, { sampling = "linear", last_frame = "exclude", orbit_radius = DEFAULT_ORBIT_RADIUS } = {}) {
  if (!events.length) throw new Error("Provide at least one camera action");
  if (!Number.isFinite(orbit_radius) || orbit_radius < 0) {
    throw new Error("Orbit radius must be finite and non-negative");
  }
  let world = eye4();
  const chunks = [], records = [], curves = [], sampleTimes = [];

  const append = (event, curve, times, poses = null) => {
    const [start, end] = curve([0.0, 1.0]);
    chunks.push(poses ?? curve(times));
    records.push({ chunk_index: records.length, event, logical_start_c2w: start, logical_end_c2w: end });
    curves.push(curve);
    sampleTimes.push(times);
    world = end;
  };

  events.forEach((event, index) => {
    if (event.startsWith("reverse")) {
      const count = Number(/[0-9]+$/.exec(event)[0]);
      if (count > chunks.length) {
        throw new Error(`${event} needs ${count} preceding chunks; only ${chunks.length} exist`);
      }
      const indices = [];
      for (let s = chunks.length - 1; s > chunks.length - count - 1; s--) indices.push(s);
      for (const source of indices) {
        if (event.startsWith("reverse_frames")) {
          const lastTime = sampleTimes[source].at(-1);
          const curve = (ts) => curves[source](ts.map((t) => lastTime * (1.0 - t)));
          append(event, curve, linspace(CHUNK_FRAMES), chunks[source].slice().reverse().map(clone4));
        } else {
          const curve = (ts) => curves[source](ts.map((t) => 1.0 - t));
          const includeEnd = last_frame === "include" && index === events.length - 1 && source === indices.at(-1);
          const times = includeEnd ? linspace(CHUNK_FRAMES) : arange(CHUNK_FRAMES);
          let poses = null;
          const original = records[source].event;
          if (sampling === "linear" && !original.includes("&") && !original.startsWith("reverse")) {
            const action = actionFromEvent(original);
            if (!action.yaw && !action.pitch && sampleTimes[source].at(-1) < 1.0 && !includeEnd) {
              // Reuse linear translation samples without another interpolation roundoff.
              const endpoint = clone4(records[source].logical_end_c2w);
              poses = [endpoint, ...chunks[source].slice(1).reverse().map(clone4)];
            }
          }
          append(event, curve, times, poses);
        }
      }
      return;
    }
    const smooth = sampling === "smooth_turns";
    const entering = index > 0 && events[index - 1] === event;
    const leaving = index + 1 < events.length && events[index + 1] === event;
    const includeEnd = (smooth && !leaving) || (last_frame === "include" && index === events.length - 1);
    const times = includeEnd ? linspace(CHUNK_FRAMES) : arange(CHUNK_FRAMES);
    const start = clone4(world);
    const tangentStart = smooth ? Number(entering) : null;
    const tangentEnd = Number(leaving);
    const curve = (ts) => sampleCurve(start, event, tangentStart, tangentEnd, ts, orbit_radius);
    append(event, curve, times);
  });
  return { camera: chunks.flat(), records };
}

// ---- helpers for the UI ------------------------------------------------------

/** Serialize an event list back to a compact script, folding runs into `xN`. */
export function formatActions(events, options = {}) {
  const headers = Object.entries(options).map(([k, v]) => `@${k} ${v}`);
  const lines = [];
  for (let i = 0; i < events.length;) {
    let j = i;
    while (j < events.length && events[j] === events[i]) j++;
    lines.push(j - i > 1 ? `${events[i]}x${j - i}` : events[i]);
    i = j;
  }
  return [...headers, ...lines].join("\n");
}

/**
 * Validate a script the way the Space does and describe what it will render.
 * Never throws; returns { ok, error?, events, options, available, rendered, camera, records }.
 */
export function analyzeScript(text, requestedChunks = SPACE_MAX_CHUNKS) {
  try {
    const { events, options } = parseTrajectory(text || "");
    const available = countChunks(events);
    const rendered = Math.max(1, Math.min(Math.trunc(requestedChunks), SPACE_MAX_CHUNKS, available));
    const { camera, records } = buildTrajectory(events, options);
    return { ok: true, events, options, available, rendered, camera, records };
  } catch (error) {
    return { ok: false, error: error.message, events: [], options: {}, available: 0, rendered: 0, camera: [], records: [] };
  }
}

/**
 * GPU seconds the Space reserves per request (its own `_duration` formula):
 * ~22 s weight streaming + first chunk + 11.4 s per extra chunk, with 15% headroom.
 */
export function estimateGpuSeconds(mode, chunks) {
  const n = Math.max(1, Math.min(Math.trunc(chunks) || 1, SPACE_MAX_CHUNKS));
  const first = mode === "t2v" ? 23.0 : 13.5;
  return Math.round(1.15 * (22.0 + first + (n - 1) * 11.4));
}

/**
 * Daily ZeroGPU quota in seconds per account tier, and the multiplier for the
 * Space's `size="xlarge"` GPU. Source: https://huggingface.co/docs/hub/spaces-zerogpu
 */
export const DAILY_QUOTA_SECONDS = { anonymous: 120, free: 300, pro: 2400 };
export const XLARGE_QUOTA_MULTIPLIER = 2;

/** Quota a render can cost, using the Space's reserved duration (an upper bound). */
export function estimateQuotaSeconds(mode, chunks) {
  return XLARGE_QUOTA_MULTIPLIER * estimateGpuSeconds(mode, chunks);
}

/** How many renders of this size fit in a tier's full daily quota. */
export function rendersPerDay(tier, mode, chunks) {
  return Math.floor((DAILY_QUOTA_SECONDS[tier] ?? DAILY_QUOTA_SECONDS.anonymous) / estimateQuotaSeconds(mode, chunks));
}

/** Top-down (x, z) position and heading (radians, 0 = +z) of a pose. */
export function poseSummary(m) {
  const fx = m[0][2], fy = m[1][2], fz = m[2][2];
  return {
    x: m[0][3], y: m[1][3], z: m[2][3],
    heading: Math.atan2(fx, fz),
    // y is down, so looking up means a negative y component of the forward axis.
    pitch: Math.asin(Math.max(-1, Math.min(1, -fy))),
  };
}
