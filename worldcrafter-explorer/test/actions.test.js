import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  analyzeScript, buildTrajectory, countChunks, estimateGpuSeconds, estimateQuotaSeconds, formatActions, rendersPerDay,
  parseTrajectory, poseSummary, SPACE_MAX_CHUNKS,
} from "../public/actions.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/golden.json", import.meta.url), "utf8"));

test("matches the official WorldCrafter camera code on every golden case", () => {
  for (const ref of golden) {
    let mine;
    try {
      const { events, options } = parseTrajectory(ref.script);
      const { camera } = buildTrajectory(events, options);
      mine = { events, options, chunks: countChunks(events), camera };
    } catch (error) {
      mine = { error: error.message };
    }
    if (ref.error !== undefined) {
      assert.equal(mine.error, ref.error, `error for ${JSON.stringify(ref.script)}`);
      continue;
    }
    assert.equal(mine.error, undefined, `unexpected error for ${JSON.stringify(ref.script)}: ${mine.error}`);
    assert.deepEqual(mine.events, ref.events);
    assert.deepEqual(mine.options, ref.options);
    assert.equal(mine.chunks, ref.chunks);
    assert.equal(mine.camera.length, ref.num_frames);
    for (const [index, expected] of Object.entries(ref.frames)) {
      const actual = mine.camera[Number(index)];
      expected.forEach((row, r) => row.forEach((value, c) => {
        assert.ok(Math.abs(actual[r][c] - value) < 1e-9, `${ref.script} frame ${index} [${r}][${c}]: ${actual[r][c]} vs ${value}`);
      }));
    }
  }
});

test("formatActions folds repeats and round-trips through the parser", () => {
  const events = ["forward1", "forward1", "yaw_left30", "forward1"];
  const text = formatActions(events, { orbit_radius: 3 });
  assert.equal(text, "@orbit_radius 3\nforward1x2\nyaw_left30\nforward1");
  assert.deepEqual(parseTrajectory(text).events, events);
});

test("analyzeScript mirrors the Space's chunk clamping and never throws", () => {
  const long = analyzeScript("forward1x9", 6);
  assert.equal(long.ok, true);
  assert.equal(long.available, 9);
  assert.equal(long.rendered, SPACE_MAX_CHUNKS);

  const short = analyzeScript("forward1 reverse1", 6);
  assert.equal(short.rendered, 2);
  assert.equal(analyzeScript("forward1x3", 2).rendered, 2);

  const bad = analyzeScript("forward9");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /must not exceed 5/);
});

test("estimateGpuSeconds uses the Space's own duration formula", () => {
  // round(1.15 * (22 + 13.5)) and round(1.15 * (22 + 13.5 + 5 * 11.4))
  assert.equal(estimateGpuSeconds("i2v", 1), 41);
  assert.equal(estimateGpuSeconds("i2v", 6), 106);
  assert.equal(estimateGpuSeconds("t2v", 1), 52);
  assert.equal(estimateGpuSeconds("i2v", 99), 106);
});

test("quota estimates count the xlarge GPU double and fit the daily tiers", () => {
  assert.equal(estimateQuotaSeconds("i2v", 1), 82);
  assert.equal(estimateQuotaSeconds("i2v", 6), 212);
  // Anonymous (120 s/day): one short render; 3+ chunks don't fit at all.
  assert.equal(rendersPerDay("anonymous", "i2v", 1), 1);
  assert.equal(rendersPerDay("anonymous", "i2v", 2), 1);
  assert.equal(rendersPerDay("anonymous", "i2v", 3), 0);
  // Free (300 s/day) and PRO (2400 s/day).
  assert.equal(rendersPerDay("free", "i2v", 1), 3);
  assert.equal(rendersPerDay("free", "i2v", 6), 1);
  assert.equal(rendersPerDay("pro", "i2v", 6), 11);
});

test("poseSummary reports heading and pitch in the model's axes", () => {
  const { camera } = buildTrajectory(parseTrajectory("yaw_right90 pitch_up30").events);
  const afterYaw = poseSummary(camera[33]);
  assert.ok(Math.abs(afterYaw.heading - Math.PI / 2) < 1e-9, "yaw_right turns toward +x");
  const moved = buildTrajectory(parseTrajectory("yaw_right90 forward2").events, { last_frame: "include" });
  const end = poseSummary(moved.camera.at(-1));
  assert.ok(Math.abs(end.x - 2) < 1e-9 && Math.abs(end.z) < 1e-9, "forward after yaw_right90 moves along +x");
  const lookUp = poseSummary(buildTrajectory(["pitch_up30"], { last_frame: "include" }).camera.at(-1));
  assert.ok(Math.abs(lookUp.pitch - Math.PI / 6) < 1e-9, "pitch_up is positive pitch");
});
