import {
  analyzeScript, countChunks, CHUNK_FRAMES, estimateGpuSeconds, formatActions, FPS, poseSummary, SPACE_MAX_CHUNKS,
} from "./actions.js";

const $ = (id) => document.getElementById(id);
const HEADERS = { "content-type": "application/json", "x-worldcrafter-explorer": "1" };
const TRANSLATIONS = new Set(["forward", "backward", "left", "right", "up", "down"]);
const KEYMAP = {
  KeyW: "forward", KeyS: "backward", KeyA: "left", KeyD: "right", KeyQ: "up", KeyE: "down",
  ArrowLeft: "yaw_left", ArrowRight: "yaw_right", ArrowUp: "pitch_up", ArrowDown: "pitch_down",
};
const TERMINAL = new Set(["done", "error", "cancelled"]);
const DRAFT_KEY = "worldcrafter-explorer:draft";

const state = {
  mode: "i2v",
  image: null, // data URL sent to the Space
  imageSource: null, // original Blob, kept so the crop toggle can re-process it
  imageLabel: "",
  parentId: null,
  label: null,
  events: [],
  options: {}, // script headers other than orbit_radius
  scriptError: null,
  orbit: false,
  status: null,
  runs: [],
  selectedId: null,
  job: null,
  examples: [],
};

// ---------------------------------------------------------------- utilities

let toastTimer;
function toast(message, ms = 4500) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(path, options = {}) {
  const response = await fetch(path, options.body ? { method: "POST", headers: HEADERS, ...options } : options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

const fmt = (n) => String(Number(Number(n).toFixed(2)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function relativeTime(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// ------------------------------------------------------------------- draft

let draftTimer;
function saveDraft({ now = false } = {}) {
  clearTimeout(draftTimer);
  const write = () => {
    const draft = {
      mode: state.mode, prompt: $("prompt").value, negative: $("negative").value, seed: $("seed").value,
      script: $("script").value, moveStep: $("move-step").value, turnStep: $("turn-step").value,
      orbit: state.orbit, orbitRadius: $("orbit-radius").value, crop: $("crop-check").checked,
      parentId: state.parentId, label: state.label, imageLabel: state.imageLabel,
      image: state.image && state.image.length < 3_000_000 ? state.image : null,
    };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage full or blocked */ }
  };
  if (now) write();
  else draftTimer = setTimeout(write, 300);
}

function loadDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { draft = null; }
  if (!draft) return;
  $("prompt").value = draft.prompt ?? "";
  $("negative").value = draft.negative ?? "";
  $("seed").value = draft.seed ?? 42;
  $("move-step").value = draft.moveStep ?? 1;
  $("turn-step").value = draft.turnStep ?? 30;
  $("orbit-radius").value = draft.orbitRadius ?? 2;
  $("crop-check").checked = draft.crop ?? true;
  state.parentId = draft.parentId ?? null;
  state.label = draft.label ?? null;
  setOrbit(Boolean(draft.orbit), { silent: true });
  setMode(draft.mode === "t2v" ? "t2v" : "i2v");
  if (draft.image) setImage(draft.image, draft.imageLabel || "restored image", null);
  if (draft.script) {
    $("script").value = draft.script;
    onScriptInput();
  }
}

// -------------------------------------------------------------- scene panel

function setMode(mode) {
  state.mode = mode;
  $("mode-i2v").setAttribute("aria-selected", String(mode === "i2v"));
  $("mode-t2v").setAttribute("aria-selected", String(mode === "t2v"));
  $("image-block").hidden = mode !== "i2v";
  refreshRoute();
  saveDraft();
}

function setImage(dataUrl, label, source) {
  state.image = dataUrl;
  state.imageLabel = label || "";
  if (source !== undefined) state.imageSource = source;
  const preview = $("image-preview");
  preview.hidden = !dataUrl;
  if (dataUrl) preview.src = dataUrl;
  else preview.removeAttribute("src");
  $("dropzone-hint").hidden = Boolean(dataUrl);
  $("image-clear").hidden = !dataUrl;
  renderParentNote();
  saveDraft();
}

function runName(id) {
  const run = state.runs.find((r) => r.id === id);
  if (!run) return "an earlier render";
  const time = new Date(run.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `your ${time} render${run.label ? ` (${run.label})` : ""}`;
}

function renderParentNote() {
  const note = $("parent-note");
  note.hidden = !state.parentId;
  note.textContent = state.parentId ? `Continuing from ${runName(state.parentId)}: this leg starts at its last frame.` : "";
}

/** Crop to 5:3 (optional), cap at 1280 px wide, and encode for upload. */
async function processImage(blob, label) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    if ($("crop-check").checked) {
      const target = 5 / 3;
      if (sw / sh > target) { const w = sh * target; sx = (sw - w) / 2; sw = w; }
      else { const h = sw / target; sy = (sh - h) / 2; sh = h; }
    }
    const scale = Math.min(1, 1280 / sw);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    setImage(canvas.toDataURL("image/jpeg", 0.95), label, blob);
  } catch {
    toast("That file could not be read as an image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function takeImageFile(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
    toast("Use a PNG, JPEG or WebP image.");
    return;
  }
  state.parentId = null;
  state.label = null;
  processImage(file, file.name || "pasted image");
}

// -------------------------------------------------------------- route panel

function orbitRadius() {
  return clamp(Number($("orbit-radius").value) || 0, 0, 10);
}

/** Script headers: parsed options plus the orbit radius when it matters. */
function headerOptions(events = state.events) {
  const options = { ...state.options };
  const radius = orbitRadius();
  if (radius !== 2 && events.some((e) => e.includes("orbit_"))) return { orbit_radius: radius, ...options };
  return options;
}

const scriptText = () => formatActions(state.events, headerOptions());

function setEvents(events) {
  state.events = events;
  state.scriptError = null;
  $("script").value = scriptText();
  refreshRoute();
  saveDraft();
}

function onScriptInput() {
  const text = $("script").value;
  const result = analyzeScript(text);
  if (!text.trim()) {
    state.events = [];
    state.options = {};
    state.scriptError = null;
  } else if (result.ok) {
    const { orbit_radius: radius, ...rest } = result.options;
    state.events = result.events;
    state.options = rest;
    if (radius !== undefined) $("orbit-radius").value = radius;
    state.scriptError = null;
  } else {
    state.scriptError = result.error;
  }
  refreshRoute();
  saveDraft();
}

function flashKey(move) {
  const key = document.querySelector(`.key[data-move="${move}"]`);
  if (!key) return;
  key.classList.add("flash");
  setTimeout(() => key.classList.remove("flash"), 160);
}

function addMove(move, merge = false) {
  if (state.scriptError) return toast("Fix the action script first (see the error under it).");
  const turn = !TRANSLATIONS.has(move);
  let name = move;
  if (turn && state.orbit) name = move.replace(/^(yaw|pitch)_/, "orbit_");
  const step = turn ? clamp(Number($("turn-step").value) || 30, 1, 180) : clamp(Number($("move-step").value) || 1, 0.05, 5);
  const token = name + fmt(step);
  let next;
  if (merge && state.events.length) {
    const last = state.events.at(-1);
    if (last.startsWith("reverse") || last.includes("orbit_") || name.startsWith("orbit_")) {
      return toast("Orbit and return moves need a chunk of their own, so they can't be merged.");
    }
    next = [...state.events.slice(0, -1), `${last}&${token}`];
  } else {
    next = [...state.events, token];
    if (countChunks(next) > SPACE_MAX_CHUNKS) {
      return toast(`The Space renders at most ${SPACE_MAX_CHUNKS} chunks per video. Render this leg, then use "Continue from last frame".`);
    }
  }
  const check = analyzeScript(formatActions(next, headerOptions(next)));
  if (!check.ok) return toast(check.error);
  flashKey(move);
  setEvents(next);
}

function undo() {
  if (!state.events.length) return;
  setEvents(state.events.slice(0, -1));
}

function removeChunk(index) {
  const next = state.events.filter((_, i) => i !== index);
  if (next.length) {
    const check = analyzeScript(formatActions(next, headerOptions(next)));
    if (!check.ok) return toast(`Can't remove that one: ${check.error}`);
  }
  setEvents(next);
}

function returnToStart() {
  const n = countChunks(state.events);
  if (!n) return toast("Plan a route first, then add the return trip.");
  if (2 * n > SPACE_MAX_CHUNKS) {
    return toast(`A round trip doubles the chunks. Keep the outbound route to ${SPACE_MAX_CHUNKS / 2} chunks or fewer.`);
  }
  setEvents([...state.events, `reverse${n}`]);
  toast("Added the return leg. Coming back to where you started is where WorldCrafter's 3D memory shows.");
}

function setOrbit(on, { silent = false } = {}) {
  state.orbit = on;
  $("look-mode").setAttribute("aria-checked", String(!on));
  $("orbit-mode").setAttribute("aria-checked", String(on));
  $("orbit-radius-field").hidden = !on;
  const labels = on ? ["orbit up", "orbit", "orbit down", "orbit"] : ["look up", "turn", "look down", "turn"];
  document.querySelectorAll(".turn-label").forEach((el, i) => { el.textContent = labels[i]; });
  if (!silent) saveDraft();
}

function currentAnalysis() {
  if (state.scriptError || !state.events.length) return null;
  return analyzeScript(scriptText());
}

function refreshRoute() {
  const analysis = currentAnalysis();
  const rendered = analysis?.rendered ?? 0;

  // Chips
  const chips = $("chips");
  chips.replaceChildren();
  if (!state.events.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No moves yet. Use the keys above or type an action script.";
    chips.append(li);
  }
  let chunk = 0;
  state.events.forEach((event, index) => {
    const size = countChunks([event]);
    const li = document.createElement("li");
    if (chunk >= SPACE_MAX_CHUNKS) li.classList.add("over");
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = size > 1 ? `${chunk + 1}–${chunk + size}` : String(chunk + 1);
    const text = document.createElement("span");
    text.textContent = event.startsWith("reverse") ? `↩ ${event}` : event.replaceAll("&", " & ");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove this chunk";
    remove.addEventListener("click", () => removeChunk(index));
    li.append(n, text, remove);
    chips.append(li);
    chunk += size;
  });

  // Script error
  $("script-error").textContent = state.scriptError ?? "";
  if (state.scriptError) $("script-details").open = true;

  // Meter
  const seconds = (rendered * CHUNK_FRAMES) / FPS;
  const available = analysis?.available ?? 0;
  const over = available > rendered;
  $("meter").innerHTML = `
    <div class="${over ? "warn" : ""}"><b>${rendered}/${SPACE_MAX_CHUNKS}</b><span>chunks${over ? ` · ${available - rendered} beyond the limit won't render` : ""}</span></div>
    <div><b>${seconds.toFixed(1)} s</b><span>of video at ${FPS} fps</span></div>
    <div><b>${rendered ? `≈${estimateGpuSeconds(state.mode, rendered)} s` : "–"}</b><span>GPU time reserved from your quota</span></div>`;

  drawMinimap(analysis);
  refreshRenderButton();
}

function refreshRenderButton() {
  const busy = Boolean(state.job && !TERMINAL.has(state.job.phase));
  const button = $("render-btn");
  button.disabled = busy;
  button.textContent = busy ? "Rendering…" : state.parentId && state.mode === "i2v" ? "Render next leg" : "Render";
}

// ------------------------------------------------------------------ minimap

function drawMinimap(analysis) {
  const canvas = $("minimap");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 520;
  const height = canvas.clientHeight || 320;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const accent = cssVar("--accent");
  const future = cssVar("--path-future");
  const grid = cssVar("--grid");
  const muted = cssVar("--muted");
  const soft = cssVar("--accent-soft");

  const frames = analysis?.ok ? analysis.camera.map(poseSummary) : [];
  const records = analysis?.ok ? analysis.records : [];
  const end = records.length ? poseSummary(records.at(-1).logical_end_c2w) : { x: 0, z: 0, heading: 0, pitch: 0, y: 0 };
  const renderedEnd = records.length && analysis.rendered < records.length
    ? poseSummary(records[analysis.rendered - 1].logical_end_c2w) : end;

  const xs = [0, end.x, ...frames.map((p) => p.x)];
  const zs = [0, end.z, ...frames.map((p) => p.z)];
  let minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const span = Math.max(4, maxX - minX, maxZ - minZ);
  const midX = (minX + maxX) / 2, midZ = (minZ + maxZ) / 2;
  const scale = Math.min(width, height) / (span * 1.35);
  const toScreen = (x, z) => [width / 2 + (x - midX) * scale, height / 2 - (z - midZ) * scale];

  // Grid, 1 unit apart (or coarser when zoomed out)
  const stepUnits = scale >= 18 ? 1 : scale >= 8 ? 2 : 5;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  const x0 = midX - width / scale / 2, x1 = midX + width / scale / 2;
  const z0 = midZ - height / scale / 2, z1 = midZ + height / scale / 2;
  ctx.beginPath();
  for (let gx = Math.ceil(x0 / stepUnits) * stepUnits; gx <= x1; gx += stepUnits) {
    const [sx] = toScreen(gx, 0);
    ctx.moveTo(sx, 0); ctx.lineTo(sx, height);
  }
  for (let gz = Math.ceil(z0 / stepUnits) * stepUnits; gz <= z1; gz += stepUnits) {
    const [, sy] = toScreen(0, gz);
    ctx.moveTo(0, sy); ctx.lineTo(width, sy);
  }
  ctx.stroke();

  const drawCamera = (pose, fill, stroke, dashed = false) => {
    const [sx, sy] = toScreen(pose.x, pose.z);
    const length = 26, half = Math.PI / 6;
    ctx.save();
    ctx.setLineDash(dashed ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    for (const a of [pose.heading - half, pose.heading + half]) ctx.lineTo(sx + Math.sin(a) * length, sy - Math.cos(a) * length);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.fill();
    ctx.restore();
  };

  // Start pose
  drawCamera({ x: 0, z: 0, heading: 0 }, "transparent", muted, true);

  if (!frames.length) {
    ctx.fillStyle = muted;
    ctx.font = `13px ${cssVar("--font")}`;
    ctx.textAlign = "center";
    ctx.fillText("Press W A S D and the arrow keys", width / 2, height / 2 + 34);
    ctx.fillText("to plan a route", width / 2, height / 2 + 52);
    $("pose-readout").textContent = "start: facing forward (+z)";
    return;
  }

  // Path: rendered part solid, beyond-limit part dashed
  const cut = analysis.rendered * CHUNK_FRAMES;
  const trace = (from, to, color, dashed) => {
    if (to - from < 1) return;
    ctx.save();
    ctx.setLineDash(dashed ? [5, 5] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 2 : 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const [sx, sy] = toScreen(frames[i].x, frames[i].z);
      if (i === from) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    ctx.restore();
  };
  trace(0, Math.min(cut + 1, frames.length), accent, false);
  if (cut < frames.length) trace(cut, frames.length, future, true);
  // Close the gap from the last sample to the logical end of the rendered part.
  const lastSample = frames[Math.min(cut, frames.length) - 1];
  if (lastSample) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(...toScreen(lastSample.x, lastSample.z));
    ctx.lineTo(...toScreen(renderedEnd.x, renderedEnd.z));
    ctx.stroke();
  }

  // Cameras first so the chunk markers stay readable on top.
  drawCamera(renderedEnd, soft, accent);
  if (renderedEnd !== end) drawCamera(end, "transparent", future, true);

  // Chunk markers. Turns start where the previous chunk ended, so markers that
  // share a spot are merged ("2–3"), and rendered chunks are drawn on top.
  const groups = new Map();
  records.forEach((record, i) => {
    const pose = poseSummary(record.logical_start_c2w);
    const key = `${Math.round(pose.x * 20)},${Math.round(pose.z * 20)}`;
    if (!groups.has(key)) groups.set(key, { x: pose.x, z: pose.z, rendered: [], future: [] });
    groups.get(key)[i < analysis.rendered ? "rendered" : "future"].push(i + 1);
  });
  const label = (nums) => (nums.length === 1 ? String(nums[0])
    : nums.at(-1) - nums[0] === nums.length - 1 ? `${nums[0]}–${nums.at(-1)}` : `${nums[0]}+`);
  ctx.font = `600 10px ${cssVar("--font")}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const sorted = [...groups.values()].sort((a, b) => Boolean(a.rendered.length) - Boolean(b.rendered.length));
  for (const group of sorted) {
    const isRendered = group.rendered.length > 0;
    const text = label(isRendered ? group.rendered : group.future);
    const [sx, sy] = toScreen(group.x, group.z);
    const w = Math.max(16, ctx.measureText(text).width + 9);
    ctx.beginPath();
    ctx.roundRect(sx - w / 2, sy - 8, w, 16, 8);
    ctx.fillStyle = isRendered ? accent : future;
    ctx.fill();
    ctx.fillStyle = cssVar("--accent-ink");
    ctx.fillText(text, sx, sy + 0.5);
  }


  const deg = (r) => Math.round((r * 180) / Math.PI);
  const heading = deg(renderedEnd.heading);
  const turn = heading === 0 ? "ahead" : heading > 0 ? `${heading}° right` : `${-heading}° left`;
  const pitch = deg(renderedEnd.pitch);
  $("pose-readout").textContent =
    `end: x ${renderedEnd.x.toFixed(1)} · z ${renderedEnd.z.toFixed(1)} · height ${(-renderedEnd.y).toFixed(1)} · facing ${turn}${pitch ? ` · looking ${pitch > 0 ? "up" : "down"} ${Math.abs(pitch)}°` : ""}`;
}

// ------------------------------------------------------------------- render

async function render() {
  if (state.job && !TERMINAL.has(state.job.phase)) return;
  const prompt = $("prompt").value.trim();
  if (!prompt) { $("prompt").focus(); return toast("Write a prompt first."); }
  if (state.mode === "i2v" && !state.image) return toast("Choose a start image, or switch to Text → video.");
  if (state.scriptError) return toast("Fix the action script first.");
  if (!state.events.length) return toast("Plan at least one move.");
  const body = {
    mode: state.mode, prompt, actions: scriptText(), seed: Number($("seed").value) || 0,
    numChunks: SPACE_MAX_CHUNKS, negativePrompt: $("negative").value.trim() || undefined,
    image: state.mode === "i2v" ? state.image : undefined,
    parentId: state.mode === "i2v" ? state.parentId ?? undefined : undefined,
    label: state.label ?? undefined,
  };
  try {
    const { job } = await api("/api/jobs", { body: JSON.stringify(body) });
    followJob(job);
  } catch (error) {
    toast(error.message, 7000);
  }
}

let elapsedTimer;
function followJob(job) {
  state.job = job;
  renderJob();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(renderElapsed, 1000);
  const source = new EventSource(`/api/jobs/${job.id}/events`);
  source.addEventListener("update", (event) => {
    state.job = JSON.parse(event.data);
    renderJob();
    if (TERMINAL.has(state.job.phase)) {
      source.close();
      finishJob(state.job);
    }
  });
  source.onerror = () => {
    if (state.job && TERMINAL.has(state.job.phase)) return;
    source.close();
    pollJob(job.id);
  };
}

async function pollJob(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const { job } = await api(`/api/jobs/${id}`);
      state.job = job;
      renderJob();
      if (TERMINAL.has(job.phase)) return finishJob(job);
    } catch {
      state.job = { ...state.job, phase: "error", error: { title: "Lost track of the render", message: "The local server restarted or the job expired. Check the gallery; if it is not there, render again." } };
      renderJob();
      return finishJob(state.job);
    }
  }
}

async function finishJob(job) {
  clearInterval(elapsedTimer);
  renderElapsed();
  refreshRenderButton();
  if (job.phase === "done") {
    await loadRuns();
    selectRun(job.run.id, { autoplay: true });
    toast("Saved to the gallery.");
  }
}

const PHASES = {
  starting: "Starting…",
  connecting: "Connecting to the Space…",
  waking: "Waking the Space up…",
  queued: "Waiting in the Space's queue",
  generating: "Generating…",
  downloading: "Downloading the video…",
  done: "Done",
  cancelled: "Cancelled",
};

function renderElapsed() {
  const job = state.job;
  if (!job) return;
  const end = TERMINAL.has(job.phase) ? job.updatedAt : Date.now();
  $("job-elapsed").textContent = `${Math.max(0, Math.round((end - job.createdAt) / 1000))} s`;
}

function renderJob() {
  const job = state.job;
  const box = $("job");
  box.hidden = !job;
  if (!job) return;
  box.classList.toggle("error", job.phase === "error");
  $("job-phase").textContent = job.phase === "error" ? job.error?.title || "Render failed" : PHASES[job.phase] || job.phase;
  const bar = $("job-bar");
  const progress = box.querySelector(".progress");
  const determinate = job.phase === "generating" && job.progress?.length;
  progress.classList.toggle("indeterminate", !TERMINAL.has(job.phase) && !determinate);
  progress.hidden = job.phase === "error" || job.phase === "cancelled";
  bar.style.width = job.phase === "done" ? "100%" : determinate ? `${(100 * (job.progress.index ?? 0)) / job.progress.length}%` : TERMINAL.has(job.phase) ? "0" : "";

  let detail = "";
  if (job.phase === "queued") {
    const pos = job.position != null ? `Position ${job.position + 1}${job.queueSize ? ` of ${job.queueSize}` : ""}` : "In line";
    detail = `${pos}${job.eta ? ` · about ${Math.round(job.eta)} s` : ""}. Other people use this free Space too.`;
  } else if (job.phase === "generating") {
    const gpuSeconds = Math.round(22 + (job.mode === "t2v" ? 23 : 13.5) + (job.numChunks - 1) * 11.4);
    const p = job.progress;
    const step = !determinate ? "Starting on the GPU…"
      : /zerogpu/i.test(p.desc || "") ? `Attaching a GPU… ${Math.round((100 * p.index) / p.length)}%`
      : `${p.desc || "Denoising step"} ${p.index}/${p.length}`;
    detail = `${step}\n${job.numChunks} chunk(s), about ${gpuSeconds} s of GPU work in total.`;
  } else if (job.phase === "waking") {
    detail = `${job.message || "The Space was asleep."} Loading 137 GB of weights can take several minutes.`;
  } else if (job.phase === "error") {
    detail = job.error?.message || "";
    if (job.error?.quota) detail += state.status?.token?.present
      ? "\n\nYour account's free GPU time for today is used up. It refills over time (a PRO account gets much more)."
      : "\n\nAdd a free Hugging Face token to get your own GPU allowance.";
  } else if (job.phase === "done") {
    detail = (job.run?.info || "").replaceAll("**", "");
  }
  $("job-detail").textContent = detail;
  $("cancel-btn").hidden = TERMINAL.has(job.phase);
  $("token-fix-btn").hidden = !(job.phase === "error" && job.error?.quota);
  renderElapsed();
  refreshRenderButton();
}

// ------------------------------------------------------------ player/gallery

const runById = (id) => state.runs.find((r) => r.id === id);

function journeyOf(run) {
  const chain = [run];
  const seen = new Set([run.id]);
  let current = run;
  while (current.parentId && runById(current.parentId) && !seen.has(current.parentId)) {
    current = runById(current.parentId);
    seen.add(current.id);
    chain.unshift(current);
  }
  return chain;
}

function selectRun(id, { autoplay = false } = {}) {
  const run = runById(id);
  state.selectedId = run ? id : null;
  document.querySelectorAll(".card").forEach((card) => card.classList.toggle("selected", card.dataset.id === id));
  $("player").hidden = !run;
  if (!run) return;
  const video = $("video");
  video.loop = true;
  video.src = `/runs/${run.id}/video.mp4`;
  if (autoplay) video.play().catch(() => {});
  const meta = $("player-meta");
  meta.replaceChildren();
  const add = (text, tag = "p") => {
    const el = document.createElement(tag);
    el.textContent = text;
    meta.append(el);
    return el;
  };
  add(`${run.mode === "i2v" ? "Image → video" : "Text → video"} · ${run.numChunks} chunk(s) · seed ${run.seed} · ${new Date(run.created).toLocaleString()} · took ${run.elapsedSec ?? "?"} s`);
  add(run.prompt.length > 220 ? `${run.prompt.slice(0, 220)}…` : run.prompt);
  const route = add("", "p");
  const code = document.createElement("code");
  const parsed = analyzeScript(run.actions);
  code.textContent = parsed.ok ? parsed.events.slice(0, run.numChunks).join(" → ") : run.actions.trim();
  route.append("Route: ", code);
  if (run.parentId) add(runById(run.parentId) ? `Continues ${runName(run.parentId)}.` : "Continued from a render that has since been deleted.");
  const link = $("download-link");
  link.href = `/runs/${run.id}/video.mp4`;
  link.download = `worldcrafter-${run.id}.mp4`;
  const legs = journeyOf(run).length;
  $("journey-btn").hidden = legs < 2;
  $("journey-btn").textContent = `Play journey (${legs} legs)`;
}

function playJourney() {
  const run = runById(state.selectedId);
  if (!run) return;
  const chain = journeyOf(run);
  const video = $("video");
  let index = 0;
  video.loop = false;
  const next = () => {
    if (index >= chain.length) {
      video.removeEventListener("ended", next);
      video.loop = true;
      return;
    }
    video.src = `/runs/${chain[index++].id}/video.mp4`;
    video.play().catch(() => {});
  };
  video.addEventListener("ended", next);
  next();
}

function seek(video, time) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("seek timed out")), 8000);
    video.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
    video.currentTime = time;
  });
}

async function continueFromLastFrame() {
  const run = runById(state.selectedId);
  if (!run) return;
  const video = $("video");
  try {
    if (!video.src.includes(run.id)) video.src = `/runs/${run.id}/video.mp4`;
    if (video.readyState < 1) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
    video.pause();
    await seek(video, Math.max(0, video.duration - 0.03));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    state.parentId = run.id;
    state.label = run.label ?? null;
    setMode("i2v");
    setImage(canvas.toDataURL("image/png"), `last frame of ${run.id}`, null);
    if (!$("prompt").value.trim()) $("prompt").value = run.prompt;
    setEvents([]);
    toast("The last frame is now your start image. Plan the next leg and render.");
    $("route-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(`Could not grab the last frame: ${error.message}`);
  }
}

async function reuseRun() {
  const run = runById(state.selectedId);
  if (!run) return;
  setMode(run.mode);
  $("prompt").value = run.prompt;
  $("negative").value = run.negativePrompt ?? "";
  $("seed").value = run.seed;
  $("script").value = run.actions;
  onScriptInput();
  state.parentId = run.parentId ?? null;
  state.label = run.label ?? null;
  if (run.mode === "i2v" && run.input) {
    try {
      const blob = await (await fetch(`/runs/${run.id}/${run.input}`)).blob();
      setImage(await blobToDataUrl(blob), `input of ${run.id}`, null);
    } catch {
      toast("Could not load that render's start image.");
    }
  }
  saveDraft();
  toast("Loaded that render's settings. Tweak and render again.");
}

async function deleteRun(id) {
  if (!confirm("Delete this render from the gallery?")) return;
  try {
    await fetch(`/api/runs/${id}`, { method: "DELETE", headers: HEADERS });
  } catch {
    return toast("Delete failed.");
  }
  if (state.selectedId === id) selectRun(null);
  await loadRuns();
}

async function loadRuns() {
  try {
    state.runs = (await api("/api/runs")).runs;
  } catch {
    state.runs = [];
  }
  renderParentNote();
  const gallery = $("gallery");
  gallery.replaceChildren();
  $("gallery-count").textContent = state.runs.length ? `${state.runs.length} render(s) saved on this computer` : "";
  if (!state.runs.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Your renders will appear here.";
    gallery.append(empty);
    return;
  }
  for (const run of state.runs) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = run.id;
    card.tabIndex = 0;
    const video = document.createElement("video");
    video.src = `/runs/${run.id}/video.mp4#t=0.5`;
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.loop = true;
    card.addEventListener("mouseenter", () => video.play().catch(() => {}));
    card.addEventListener("mouseleave", () => video.pause());
    const body = document.createElement("div");
    body.className = "card-body";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = run.label ? `${run.label}: ${run.prompt}` : run.prompt;
    const meta = document.createElement("div");
    meta.className = "card-meta";
    const info = document.createElement("span");
    info.textContent = `${run.mode.toUpperCase()} · ${run.numChunks} ch${run.parentId ? " · continued" : ""} · ${relativeTime(run.created)}`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", (event) => { event.stopPropagation(); deleteRun(run.id); });
    meta.append(info, del);
    body.append(title, meta);
    card.append(video, body);
    card.addEventListener("click", () => selectRun(run.id, { autoplay: true }));
    card.addEventListener("keydown", (event) => { if (event.key === "Enter") selectRun(run.id, { autoplay: true }); });
    gallery.append(card);
  }
  if (state.selectedId) document.querySelector(`.card[data-id="${state.selectedId}"]`)?.classList.add("selected");
}

// ------------------------------------------------------------ status/token

async function loadStatus() {
  try {
    state.status = await api("/api/status");
  } catch {
    $("space-pill").className = "pill bad";
    $("space-pill").textContent = "Local server not responding";
    return;
  }
  const stage = state.status.space.stage;
  const spacePill = $("space-pill");
  const stages = {
    RUNNING: ["good", "Space: running"],
    SLEEPING: ["warn", "Space: asleep (first render wakes it, can take minutes)"],
    BUILDING: ["warn", "Space: rebuilding"],
    APP_STARTING: ["warn", "Space: starting"],
    RUNNING_APP_STARTING: ["warn", "Space: starting"],
    PAUSED: ["bad", "Space: paused by its owner"],
    RUNTIME_ERROR: ["bad", "Space: crashed"],
    UNREACHABLE: ["bad", "Space: can't reach Hugging Face"],
  };
  const [tone, text] = stages[stage] ?? ["warn", `Space: ${String(stage).toLowerCase()}`];
  spacePill.className = `pill ${tone}`;
  spacePill.textContent = text;

  const token = state.status.token;
  const tokenPill = $("token-pill");
  if (token.present && token.user) {
    tokenPill.className = "pill pill-button good";
    tokenPill.textContent = `Signed in as ${token.user}`;
  } else if (token.present) {
    tokenPill.className = "pill pill-button warn";
    tokenPill.textContent = token.error ? "Token problem, check it" : "Token saved (unverified)";
  } else {
    tokenPill.className = "pill pill-button warn";
    tokenPill.textContent = "No token: limited free GPU";
  }
  if (state.status.activeJob && !state.job) {
    try {
      const { job } = await api(`/api/jobs/${state.status.activeJob}`);
      followJob(job);
    } catch { /* finished meanwhile */ }
  }
}

function openTokenDialog() {
  const token = state.status?.token;
  $("token-current").textContent = token?.present
    ? `Current: ${token.masked} from ${token.source}${token.user ? `, signed in as ${token.user}` : ""}${token.error ? ` (${token.error})` : ""}.`
    : "No token set.";
  $("token-error").textContent = "";
  $("token-input").value = "";
  $("token-remove").hidden = token?.source !== "saved in this app";
  $("token-dialog").showModal();
  $("token-input").focus();
}

async function saveToken(value) {
  $("token-error").textContent = "";
  $("token-save").disabled = true;
  try {
    await api("/api/settings/token", { body: JSON.stringify({ token: value }) });
    $("token-dialog").close();
    await loadStatus();
    toast(value ? "Token saved." : "Saved token removed.");
  } catch (error) {
    $("token-error").textContent = error.message;
  } finally {
    $("token-save").disabled = false;
  }
}

// ----------------------------------------------------------------- examples

async function loadExamples() {
  try {
    state.examples = (await api("/api/examples")).examples;
  } catch {
    $("example-select").options[0].textContent = "Examples unavailable (offline?)";
    return;
  }
  const select = $("example-select");
  for (const [mode, label] of [["i2v", "Image → video"], ["t2v", "Text → video"]]) {
    const group = document.createElement("optgroup");
    group.label = label;
    state.examples.filter((e) => e.mode === mode).forEach((example) => {
      const option = document.createElement("option");
      option.value = `${mode}/${example.name}`;
      option.textContent = example.label;
      group.append(option);
    });
    if (group.children.length) select.append(group);
  }
}

async function applyExample(value) {
  const [mode, name] = value.split("/");
  const example = state.examples.find((e) => e.mode === mode && e.name === name);
  if (!example) return;
  state.parentId = null;
  state.label = example.label;
  setMode(mode);
  $("prompt").value = example.prompt;
  $("script").value = example.actions;
  onScriptInput();
  if (mode === "i2v") {
    try {
      const blob = await (await fetch(`/api/examples/${encodeURIComponent(name)}/image`)).blob();
      await processImage(blob, `example: ${example.label}`);
    } catch {
      toast("Could not download the example image.");
    }
  }
  const analysis = currentAnalysis();
  if (analysis?.available > SPACE_MAX_CHUNKS) {
    toast(`This official route has ${analysis.available} chunks; the free Space renders the first ${SPACE_MAX_CHUNKS}.`, 6000);
  }
  saveDraft();
}

// -------------------------------------------------------------------- wiring

function isTyping(target) {
  return Boolean(target.closest?.("input, textarea, select, [contenteditable='true']"));
}

function wire() {
  $("mode-i2v").addEventListener("click", () => setMode("i2v"));
  $("mode-t2v").addEventListener("click", () => setMode("t2v"));
  $("example-select").addEventListener("change", (event) => {
    if (event.target.value) applyExample(event.target.value);
    event.target.value = "";
  });

  const dropzone = $("dropzone");
  dropzone.addEventListener("click", () => $("image-input").click());
  dropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); $("image-input").click(); } });
  $("image-input").addEventListener("change", (event) => { takeImageFile(event.target.files[0]); event.target.value = ""; });
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("drag"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag");
    takeImageFile(event.dataTransfer.files[0]);
  });
  document.addEventListener("paste", (event) => {
    const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    if (item) {
      event.preventDefault();
      setMode("i2v");
      takeImageFile(item.getAsFile());
    }
  });
  $("image-clear").addEventListener("click", () => { state.parentId = null; setImage(null, "", null); });
  $("crop-check").addEventListener("change", () => {
    if (state.imageSource) processImage(state.imageSource, state.imageLabel);
    saveDraft();
  });

  for (const id of ["prompt", "negative", "seed", "move-step", "turn-step"]) $(id).addEventListener("input", saveDraft);
  $("seed-random").addEventListener("click", () => { $("seed").value = Math.floor(Math.random() * 2 ** 31); saveDraft(); });
  $("orbit-radius").addEventListener("input", () => {
    if (state.events.some((e) => e.includes("orbit_"))) {
      const check = analyzeScript(scriptText());
      if (!check.ok) toast(check.error);
    }
    $("script").value = scriptText();
    refreshRoute();
    saveDraft();
  });
  $("look-mode").addEventListener("click", () => setOrbit(false));
  $("orbit-mode").addEventListener("click", () => setOrbit(true));

  document.querySelectorAll(".key").forEach((key) => {
    key.addEventListener("click", (event) => addMove(key.dataset.move, event.shiftKey));
  });
  $("undo-btn").addEventListener("click", undo);
  $("clear-btn").addEventListener("click", () => setEvents([]));
  $("reverse-btn").addEventListener("click", returnToStart);
  $("script").addEventListener("input", onScriptInput);

  $("render-btn").addEventListener("click", render);
  $("cancel-btn").addEventListener("click", () => state.job && api(`/api/jobs/${state.job.id}/cancel`, { body: "{}" }).catch(() => {}));
  $("token-fix-btn").addEventListener("click", openTokenDialog);
  $("continue-btn").addEventListener("click", continueFromLastFrame);
  $("reuse-btn").addEventListener("click", reuseRun);
  $("journey-btn").addEventListener("click", playJourney);

  $("token-pill").addEventListener("click", openTokenDialog);
  $("token-form").addEventListener("submit", (event) => { event.preventDefault(); saveToken($("token-input").value.trim()); });
  $("token-cancel").addEventListener("click", () => $("token-dialog").close());
  $("token-remove").addEventListener("click", () => saveToken(""));

  document.addEventListener("keydown", (event) => {
    if ($("token-dialog").open) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      render();
      return;
    }
    if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    const move = KEYMAP[event.code] ?? KEYMAP[event.key];
    if (move) {
      event.preventDefault();
      if (!event.repeat) addMove(move, event.shiftKey);
    } else if (event.key === "Backspace") {
      event.preventDefault();
      undo();
    }
  });

  window.addEventListener("pagehide", () => saveDraft({ now: true }));
  window.addEventListener("resize", () => drawMinimap(currentAnalysis()));
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => drawMinimap(currentAnalysis()));
}

wire();
loadDraft();
refreshRoute();
loadStatus();
loadRuns();
loadExamples();
setInterval(loadStatus, 60000);
