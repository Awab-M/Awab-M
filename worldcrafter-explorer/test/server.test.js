import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, CLIENT_HEADER } from "../src/app.js";
import { SpaceError, findFileUrl, phaseFor } from "../src/space.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class FakeSpace {
  constructor() { this.calls = []; this.mode = "ok"; this.release = null; }
  async submit(request, { token, onUpdate, signal }) {
    this.calls.push({ request, token });
    onUpdate({ phase: "queued", position: 2, queueSize: 3, eta: 40 });
    if (this.mode === "hold") {
      await new Promise((resolve, reject) => {
        this.release = resolve;
        signal.addEventListener("abort", () => reject(new SpaceError("Cancelled", "cancelled")));
      });
    }
    if (this.mode === "quota") throw new SpaceError("ZeroGPU quota exceeded", "You have exceeded your ZeroGPU runs limit.", { quota: true });
    onUpdate({ phase: "generating", progress: { index: 1, length: 6, desc: "steps" } });
    return { video: Buffer.from("fake-mp4-bytes"), info: `**${request.numChunks} chunk(s)**` };
  }
}

let server, base, dataDir, space;
const fakeFetch = async (url) => {
  if (String(url).includes("/api/spaces/")) return new Response(JSON.stringify({ runtime: { stage: "RUNNING" } }));
  throw new Error("offline");
};

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "wce-"));
  space = new FakeSpace();
  const handler = createApp({
    dataDir, space, spaceId: "test/space", fetchImpl: fakeFetch, log: () => {},
    whoami: async (token) => (token.endsWith("bad") ? { ok: false, error: "Hugging Face rejected this token." } : { ok: true, user: "tester" }),
  });
  server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (path, body, headers = {}) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json", [CLIENT_HEADER]: "1", ...headers }, body: JSON.stringify(body),
});

async function waitForJob(id) {
  for (let i = 0; i < 100; i++) {
    const { job } = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (["done", "error", "cancelled"].includes(job.phase)) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job did not finish");
}

test("serves the UI and the shared action module", async () => {
  const html = await fetch(base + "/");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  const js = await fetch(base + "/actions.js");
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(base + "/../package.json")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e/package.json")).status, 404);
});

test("rejects non-local Host headers and cross-site writes", async () => {
  const { request } = await import("node:http");
  const status = await new Promise((resolve) => {
    request(`${base}/api/status`, { headers: { host: "evil.example" } }, (res) => resolve(res.statusCode)).end();
  });
  assert.equal(status, 403);
  const noHeader = await fetch(base + "/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noHeader.status, 403);
});

test("status reports the Space stage and no token by default", async () => {
  const body = await (await fetch(base + "/api/status")).json();
  assert.equal(body.space.stage, "RUNNING");
  assert.equal(body.token.present, false);
  assert.equal(body.maxChunks, 6);
});

test("token settings verify, mask and never echo the token", async () => {
  const bad = await post("/api/settings/token", { token: "hf_" + "a".repeat(30) + "bad" });
  assert.equal(bad.status, 400);
  const good = await post("/api/settings/token", { token: "hf_" + "b".repeat(30) + "wxyz" });
  const body = await good.json();
  assert.equal(good.status, 200);
  assert.equal(body.token.user, "tester");
  assert.equal(body.token.masked, "hf_…wxyz");
  assert.ok(!JSON.stringify(body).includes("bbbbbbbb"));
  const status = await (await fetch(base + "/api/status")).json();
  assert.equal(status.token.source, "saved in this app");
  await post("/api/settings/token", { token: "" });
});

test("validates render requests before touching the Space", async () => {
  const before = space.calls.length;
  const cases = [
    [{ mode: "x", prompt: "p", actions: "forward1" }, /Mode/],
    [{ mode: "t2v", prompt: " ", actions: "forward1" }, /prompt/],
    [{ mode: "t2v", prompt: "p", actions: "forward9" }, /Invalid camera actions/],
    [{ mode: "t2v", prompt: "p", actions: "forward1", numChunks: 7 }, /Chunks/],
    [{ mode: "t2v", prompt: "p", actions: "forward1", seed: -1 }, /Seed/],
    [{ mode: "i2v", prompt: "p", actions: "forward1" }, /start image/],
    [{ mode: "i2v", prompt: "p", actions: "forward1", image: "data:text/plain;base64,aGk=" }, /start image/],
  ];
  for (const [body, pattern] of cases) {
    const res = await post("/api/jobs", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, pattern);
  }
  assert.equal(space.calls.length, before);
});

test("an image render is saved to the gallery with its metadata", async () => {
  space.mode = "ok";
  const res = await post("/api/jobs", { mode: "i2v", prompt: "a waterfall", actions: "forward1x9", numChunks: 6, seed: 7, image: PNG, label: "test" });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  const done = await waitForJob(job.id);
  assert.equal(done.phase, "done");
  assert.equal(done.run.numChunks, 6, "clamped to the Space maximum");
  assert.equal(done.run.availableChunks, 9);
  assert.equal(space.calls.at(-1).request.numChunks, 6);
  assert.ok(Buffer.isBuffer(space.calls.at(-1).request.image));

  const video = await fetch(`${base}/runs/${done.run.id}/video.mp4`);
  assert.equal(await video.text(), "fake-mp4-bytes");
  const partial = await fetch(`${base}/runs/${done.run.id}/video.mp4`, { headers: { range: "bytes=0-3" } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "fake");
  assert.equal((await fetch(`${base}/runs/${done.run.id}/input.png`)).status, 200);

  const { runs } = await (await fetch(base + "/api/runs")).json();
  assert.equal(runs[0].id, done.run.id);
  assert.equal(runs[0].prompt, "a waterfall");
  assert.equal(runs[0].seed, 7);

  const del = await fetch(`${base}/api/runs/${done.run.id}`, { method: "DELETE", headers: { [CLIENT_HEADER]: "1" } });
  assert.equal(del.status, 200);
  assert.equal((await (await fetch(base + "/api/runs")).json()).runs.length, 0);
  assert.equal((await fetch(`${base}/api/runs/..%2F..%2Fx`, { method: "DELETE", headers: { [CLIENT_HEADER]: "1" } })).status, 400);
});

test("quota errors are surfaced with a flag the UI can act on", async () => {
  space.mode = "quota";
  const { job } = await (await post("/api/jobs", { mode: "t2v", prompt: "a city", actions: "forward1" })).json();
  const done = await waitForJob(job.id);
  assert.equal(done.phase, "error");
  assert.equal(done.error.quota, true);
  assert.match(done.error.message, /ZeroGPU/);
});

test("one render at a time, cancellable, with a live event stream", async () => {
  space.mode = "hold";
  const { job } = await (await post("/api/jobs", { mode: "t2v", prompt: "a city", actions: "forward1" })).json();
  const second = await post("/api/jobs", { mode: "t2v", prompt: "again", actions: "forward1" });
  assert.equal(second.status, 409);

  const events = await fetch(`${base}/api/jobs/${job.id}/events`);
  const reader = events.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: update/);

  await post(`/api/jobs/${job.id}/cancel`, {});
  const done = await waitForJob(job.id);
  assert.equal(done.phase, "cancelled");
  let text = "";
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    text += new TextDecoder().decode(value);
  }
  assert.match(text, /"phase":"cancelled"/);
  space.mode = "ok";
});

test("findFileUrl handles the payload shapes Gradio uses for videos", () => {
  assert.equal(findFileUrl({ video: { url: "https://x/a.mp4" }, subtitles: null }), "https://x/a.mp4");
  assert.equal(findFileUrl({ url: "https://x/b.mp4", path: "/tmp/b.mp4" }), "https://x/b.mp4");
  assert.equal(findFileUrl("https://x/c.mp4"), "https://x/c.mp4");
  assert.equal(findFileUrl({ path: "/tmp/only-path" }), null);
});

test("phaseFor tells queueing from generating although Gradio says pending for both", () => {
  // Shapes observed from the live Space: estimation, process start, ZeroGPU init, denoising steps.
  assert.equal(phaseFor({ stage: "pending", position: 0, size: 1, eta: 46 }, false), "queued");
  assert.equal(phaseFor({ stage: "pending", original_msg: "process_starts", position: 0 }, false), "generating");
  assert.equal(phaseFor({ stage: "pending", progress_data: [{ index: 35, length: 100, desc: "ZeroGPU init" }] }, false), "generating");
  assert.equal(phaseFor({ stage: "pending", progress_data: [{ index: 4, length: 6, desc: null }] }, false), "generating");
  assert.equal(phaseFor({ stage: "pending", position: 0 }, true), "generating", "stays generating once started");
  assert.equal(phaseFor({ stage: "generating" }, false), "generating");
});

test("examples come from the Space repo and are cached on disk", async () => {
  const dir = join(dataDir, "examples", "I2V");
  await mkdir(join(dir, "00_demo"), { recursive: true });
  await writeFile(join(dir, "index.json"), JSON.stringify([{ type: "directory", path: "examples/I2V/00_demo" }]));
  await writeFile(join(dir, "00_demo", "prompt.txt"), "a demo scene");
  await writeFile(join(dir, "00_demo", "actions.txt"), "forward1");
  await mkdir(join(dataDir, "examples", "T2V"), { recursive: true });
  await writeFile(join(dataDir, "examples", "T2V", "index.json"), "[]");
  const { examples } = await (await fetch(base + "/api/examples")).json();
  assert.deepEqual(examples, [{ mode: "i2v", name: "00_demo", label: "demo", prompt: "a demo scene", actions: "forward1" }]);
});
