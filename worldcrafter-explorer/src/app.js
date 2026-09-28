// HTTP API + static files for WorldCrafter Explorer. No framework; one job at a time.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { analyzeScript, SPACE_MAX_CHUNKS } from "../public/actions.js";
import { Examples } from "./examples.js";
import { SpaceError } from "./space.js";
import { RunStore } from "./store.js";
import { maskToken, TokenStore, whoami as realWhoami } from "./token.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4",
  ".json": "application/json",
};
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_BODY = 24 * 1024 * 1024;
const MAX_SEED = 2 ** 31 - 1;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export const CLIENT_HEADER = "x-worldcrafter-explorer";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readJson(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw new HttpError(415, "Expected a JSON body.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request is too large (limit 24 MB).");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
}

async function sendFile(req, res, file, { cache = "no-cache" } = {}) {
  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw new HttpError(404, "Not found.");
  }
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": cache };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, info.size - 1);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": info.size });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

function decodeImage(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || "");
  if (!match) throw new HttpError(400, "The start image must be a PNG, JPEG or WebP data URL.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) throw new HttpError(400, "The start image is empty.");
  return { bytes, type: match[1], ext: IMAGE_TYPES[match[1]] };
}

/** Validate a render request exactly as far as we can before spending GPU quota. */
export function validateRequest(body) {
  const mode = body.mode;
  if (mode !== "i2v" && mode !== "t2v") throw new HttpError(400, "Mode must be i2v or t2v.");
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw new HttpError(400, "A prompt is required.");
  if (prompt.length > 4000) throw new HttpError(400, "The prompt is too long (limit 4000 characters).");
  const actions = typeof body.actions === "string" ? body.actions : "";
  if (actions.length > 10000) throw new HttpError(400, "The action script is too long.");
  const numChunks = Number(body.numChunks ?? SPACE_MAX_CHUNKS);
  if (!Number.isInteger(numChunks) || numChunks < 1 || numChunks > SPACE_MAX_CHUNKS) {
    throw new HttpError(400, `Chunks must be a whole number from 1 to ${SPACE_MAX_CHUNKS}.`);
  }
  const analysis = analyzeScript(actions, numChunks);
  if (!analysis.ok) throw new HttpError(400, `Invalid camera actions: ${analysis.error}`);
  const seed = Number(body.seed ?? 42);
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) throw new HttpError(400, `Seed must be a whole number from 0 to ${MAX_SEED}.`);
  const negativePrompt = typeof body.negativePrompt === "string" && body.negativePrompt.trim() ? body.negativePrompt.trim() : undefined;
  if (negativePrompt && negativePrompt.length > 4000) throw new HttpError(400, "The negative prompt is too long.");
  const image = mode === "i2v" ? decodeImage(body.image) : null;
  if (mode === "i2v" && !image) throw new HttpError(400, "Image mode needs a start image.");
  const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : undefined;
  const label = typeof body.label === "string" ? body.label.slice(0, 120) : undefined;
  return { mode, prompt, actions, numChunks: analysis.rendered, availableChunks: analysis.available, seed, negativePrompt, image, parentId, label };
}

export function createApp({ dataDir, space, spaceId, whoami = realWhoami, fetchImpl = fetch, log = console.log }) {
  const store = new RunStore(dataDir);
  const tokens = new TokenStore(dataDir);
  const examples = new Examples(dataDir, { spaceId, fetchImpl });
  const jobs = new Map();
  let activeJob = null;
  let spaceStage = { value: null, at: 0 };
  let tokenUser = { token: null, user: null };

  async function spaceStatus() {
    if (Date.now() - spaceStage.at < 30000) return spaceStage.value;
    try {
      const response = await fetchImpl(`https://huggingface.co/api/spaces/${spaceId}`, { signal: AbortSignal.timeout(8000) });
      const body = await response.json();
      spaceStage = { value: body?.runtime?.stage ?? "UNKNOWN", at: Date.now() };
    } catch {
      spaceStage = { value: "UNREACHABLE", at: Date.now() };
    }
    return spaceStage.value;
  }

  async function tokenStatus() {
    const { token, source } = await tokens.resolve();
    if (token && tokenUser.token !== token) {
      const check = await whoami(token);
      tokenUser = { token, user: check.ok ? check.user : null, pro: Boolean(check.pro), error: check.ok ? null : check.error };
    }
    return {
      present: Boolean(token), source, masked: maskToken(token),
      user: token ? tokenUser.user : null, error: token ? tokenUser.error : null,
      // Quota tier for the page's estimates; an unverified token is treated as a free account.
      tier: !token ? "anonymous" : tokenUser.pro ? "pro" : "free",
    };
  }

  function publicJob(job) {
    const { controller, listeners, request, ...rest } = job;
    return rest;
  }

  function update(job, patch) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    const payload = `event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
    for (const res of job.listeners) res.write(payload);
    if (["done", "error", "cancelled"].includes(job.phase)) {
      for (const res of job.listeners) res.end();
      job.listeners.clear();
    }
  }

  async function runJob(job) {
    const { request } = job;
    const started = Date.now();
    try {
      const { token } = await tokens.resolve();
      // Cancelled before we got this far: don't send anything to the Space.
      if (job.controller.signal.aborted) throw new SpaceError("Cancelled", "The render was cancelled.");
      const result = await space.submit(
        { ...request, image: request.image?.bytes, imageType: request.image?.type },
        { token, signal: job.controller.signal, onUpdate: (patch) => update(job, patch) },
      );
      const run = await store.save({
        created: new Date().toISOString(),
        mode: request.mode, prompt: request.prompt, actions: request.actions,
        negativePrompt: request.negativePrompt ?? null, seed: request.seed,
        numChunks: request.numChunks, availableChunks: request.availableChunks,
        parentId: request.parentId ?? null, label: request.label ?? null,
        info: result.info, elapsedSec: Math.round((Date.now() - started) / 100) / 10,
      }, { video: result.video, image: request.image?.bytes, imageExt: request.image?.ext });
      log(`[render] ${request.mode} ${request.numChunks} chunk(s) saved as ${run.id}`);
      update(job, { phase: "done", run });
    } catch (error) {
      const cancelled = job.controller.signal.aborted;
      const title = error instanceof SpaceError ? error.title : "Render failed";
      log(`[render] ${cancelled ? "cancelled" : `failed: ${title}: ${error.message}`}`);
      update(job, {
        phase: cancelled ? "cancelled" : "error",
        error: cancelled ? null : { title, message: error.message, quota: Boolean(error.quota) },
      });
    } finally {
      if (activeJob === job) activeJob = null;
      // Keep finished jobs briefly so a reconnecting page can read the outcome.
      setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000).unref?.();
    }
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (method !== "GET" && method !== "HEAD" && req.headers[CLIENT_HEADER] !== "1") {
      throw new HttpError(403, "Missing client header.");
    }

    if (pathname === "/api/status" && method === "GET") {
      const [stage, token] = await Promise.all([spaceStatus(), tokenStatus()]);
      return sendJson(res, 200, { space: { id: spaceId, stage }, token, activeJob: activeJob?.id ?? null, maxChunks: SPACE_MAX_CHUNKS });
    }

    if (pathname === "/api/settings/token" && method === "POST") {
      const body = await readJson(req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (token && !/^hf_[A-Za-z0-9]{20,}$/.test(token)) throw new HttpError(400, "That does not look like a Hugging Face token (they start with hf_).");
      if (token) {
        const check = await whoami(token);
        if (!check.ok && !check.unverified) throw new HttpError(400, check.error);
        tokenUser = { token, user: check.ok ? check.user : null, pro: Boolean(check.pro), error: check.ok ? null : check.error };
      }
      await tokens.save(token || null);
      return sendJson(res, 200, { token: await tokenStatus() });
    }

    if (pathname === "/api/examples" && method === "GET") {
      try {
        return sendJson(res, 200, { examples: await examples.list() });
      } catch (error) {
        throw new HttpError(502, `Could not load examples: ${error.message}`);
      }
    }

    let match = /^\/api\/examples\/([^/]+)\/image$/.exec(pathname);
    if (match && method === "GET") {
      let png;
      try {
        png = await examples.image(decodeURIComponent(match[1]));
      } catch (error) {
        throw new HttpError(404, error.message);
      }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
      return res.end(png);
    }

    if (pathname === "/api/runs" && method === "GET") return sendJson(res, 200, { runs: await store.list() });

    match = /^\/api\/runs\/([^/]+)$/.exec(pathname);
    if (match && method === "DELETE") {
      try {
        await store.remove(match[1]);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      return sendJson(res, 200, { ok: true });
    }

    match = /^\/runs\/([^/]+)\/(video\.mp4|input\.(?:png|jpg|webp))$/.exec(pathname);
    if (match && (method === "GET" || method === "HEAD")) {
      let dir;
      try {
        dir = store.dir(match[1]);
      } catch {
        throw new HttpError(404, "Not found.");
      }
      return sendFile(req, res, join(dir, match[2]), { cache: "max-age=31536000, immutable" });
    }

    if (pathname === "/api/jobs" && method === "POST") {
      if (activeJob) throw new HttpError(409, "A render is already running. Wait for it or cancel it first.");
      const request = validateRequest(await readJson(req));
      const job = {
        id: randomUUID(), phase: "starting", createdAt: Date.now(), updatedAt: Date.now(),
        mode: request.mode, numChunks: request.numChunks, availableChunks: request.availableChunks,
        request, controller: new AbortController(), listeners: new Set(),
      };
      jobs.set(job.id, job);
      activeJob = job;
      runJob(job);
      return sendJson(res, 202, { job: publicJob(job) });
    }

    match = /^\/api\/jobs\/([0-9a-f-]{36})(\/events|\/cancel)?$/.exec(pathname);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) throw new HttpError(404, "Unknown or expired job.");
      if (!match[2] && method === "GET") return sendJson(res, 200, { job: publicJob(job) });
      if (match[2] === "/cancel" && method === "POST") {
        job.controller.abort();
        return sendJson(res, 200, { job: publicJob(job) });
      }
      if (match[2] === "/events" && method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
        if (["done", "error", "cancelled"].includes(job.phase)) return res.end();
        job.listeners.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => {
          clearInterval(ping);
          job.listeners.delete(res);
        });
        return;
      }
    }

    if (method === "GET" || method === "HEAD") {
      let rel;
      try {
        rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      } catch {
        throw new HttpError(400, "Malformed URL.");
      }
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) throw new HttpError(404, "Not found.");
      return sendFile(req, res, file);
    }
    throw new HttpError(404, "Not found.");
  }

  const handler = async (req, res) => {
    try {
      if (!LOCAL_HOST.test(req.headers.host || "")) throw new HttpError(403, "This app only answers on localhost.");
      await route(req, res, new URL(req.url, "http://localhost"));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`[error] ${req.method} ${req.url}: ${error.stack || error}`);
      if (!res.headersSent) sendJson(res, status, { error: error.message });
      else res.end();
    }
  };
  handler.cancelActive = () => activeJob?.controller.abort();
  return handler;
}
