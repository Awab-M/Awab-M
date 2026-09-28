// Talks to the public WorldCrafter Space through the official Gradio client.

import { Client, handle_file } from "@gradio/client";

export const DEFAULT_SPACE = "Drexubery/worldcrafter-demo";

export class SpaceError extends Error {
  constructor(title, message, { quota = false } = {}) {
    super(message);
    this.title = title;
    this.quota = quota;
  }
}

function messageText(message) {
  if (Array.isArray(message)) return message.map((m) => m?.message ?? String(m)).join("; ");
  return message ? String(message) : "";
}

/** Find the first downloadable file URL inside a Gradio payload. */
export function findFileUrl(value) {
  if (!value) return null;
  if (typeof value === "string") return /^https?:\/\//.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findFileUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === "object") {
    if (typeof value.url === "string" && value.url) return value.url;
    for (const key of ["video", "value", "path"]) {
      const url = findFileUrl(value[key]);
      if (url) return url;
    }
  }
  return null;
}

/**
 * Map a Gradio status event to our phase. The client reports stage "pending" for
 * queue estimates, process start and step progress alike, so look at the payload.
 */
export function phaseFor(event, started) {
  if (event.stage === "generating" || event.stage === "streaming") return "generating";
  if (started || event.original_msg === "process_starts") return "generating";
  if (event.progress_data?.some((p) => p && p.length)) return "generating";
  return "queued";
}

/**
 * Turns the Space's per-chunk step bars into { index, length, desc, chunk }. The bar
 * restarts for every chunk, and between chunks no progress is sent, so keep the last one.
 */
export class ProgressTracker {
  constructor() {
    this.chunk = 0;
    this.lastIndex = null;
    this.last = null;
  }

  update(progressData) {
    const p = progressData?.find((x) => x && x.length);
    if (!p) return this.last;
    const index = p.index ?? 0;
    if (/zerogpu/i.test(p.desc || "")) {
      this.last = { index, length: p.length, desc: p.desc, chunk: null };
      return this.last;
    }
    if (this.lastIndex === null || index < this.lastIndex) this.chunk++;
    this.lastIndex = index;
    this.last = { index, length: p.length, desc: p.desc ?? null, chunk: this.chunk };
    return this.last;
  }
}

/**
 * Real backend. `submit` resolves with { video: Buffer, info } or rejects with SpaceError.
 * `onUpdate` receives { phase, position, queueSize, eta, progress, message }.
 */
export class SpaceBackend {
  constructor({ spaceId = DEFAULT_SPACE } = {}) {
    this.spaceId = spaceId;
    this.clients = new Map(); // token -> Promise<Client>
  }

  async connect(token, onUpdate) {
    const key = token || "";
    if (!this.clients.has(key)) {
      const options = {
        events: ["data", "status"],
        status_callback: (status) => {
          if (status?.status && status.status !== "running") {
            onUpdate?.({ phase: "waking", message: status.message || `Space is ${String(status.status).toLowerCase()}` });
          }
        },
      };
      if (token) options.token = token;
      const pending = Client.connect(this.spaceId, options);
      this.clients.set(key, pending);
      pending.catch(() => this.clients.delete(key));
    }
    return this.clients.get(key);
  }

  async submit(request, { token, onUpdate = () => {}, signal } = {}) {
    onUpdate({ phase: "connecting" });
    let client;
    try {
      client = await this.connect(token, onUpdate);
    } catch (error) {
      throw new SpaceError("Could not reach the WorldCrafter Space", messageText(error?.message ?? error));
    }

    const payload = {
      prompt: request.prompt,
      actions: request.actions,
      negative_prompt: request.negativePrompt,
      num_chunks: request.numChunks,
      seed: request.seed,
    };
    if (request.mode === "i2v") payload.image = handle_file(new Blob([request.image], { type: request.imageType || "image/png" }));
    const endpoint = request.mode === "i2v" ? "/generate_i2v" : "/generate_t2v";

    if (signal?.aborted) throw new SpaceError("Cancelled", "The render was cancelled.");
    const job = client.submit(endpoint, payload);
    const abort = () => job.cancel?.().catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    let started = false;
    const tracker = new ProgressTracker();
    try {
      for await (const event of job) {
        if (signal?.aborted) throw new SpaceError("Cancelled", "The render was cancelled.");
        if (event.type === "status") {
          if (event.stage === "error") {
            const message = messageText(event.message) || "The Space reported an error.";
            const quota = /quota|runs limit/i.test(`${event.title} ${message}`);
            throw new SpaceError(event.title || "The Space reported an error", message, { quota });
          }
          if (event.stage === "complete") continue;
          const phase = phaseFor(event, started);
          started = phase === "generating";
          const progress = tracker.update(event.progress_data);
          onUpdate(phase === "queued"
            ? { phase, position: event.position ?? null, queueSize: event.size ?? null, eta: event.eta ?? null, progress: null }
            : { phase, position: null, queueSize: null, eta: null, progress });
        } else if (event.type === "data") {
          const url = findFileUrl(event.data?.[0]);
          const info = typeof event.data?.[1] === "string" ? event.data[1] : "";
          if (!url) throw new SpaceError("No video returned", "The Space finished but did not return a video.");
          onUpdate({ phase: "downloading" });
          const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
          if (!response.ok) throw new SpaceError("Download failed", `Fetching the video returned HTTP ${response.status}.`);
          return { video: Buffer.from(await response.arrayBuffer()), info };
        }
      }
      if (signal?.aborted) throw new SpaceError("Cancelled", "The render was cancelled.");
      throw new SpaceError("No result", "The Space closed the connection without a result.");
    } catch (error) {
      if (error instanceof SpaceError) throw error;
      if (signal?.aborted) throw new SpaceError("Cancelled", "The render was cancelled.");
      throw new SpaceError("Render failed", messageText(error?.message ?? error));
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
