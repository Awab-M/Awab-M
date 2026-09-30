#!/usr/bin/env node
// WorldCrafter Explorer: a local route planner + gallery for the free WorldCrafter Space.
//   node server.js [--port 7788] [--data ./data] [--space Drexubery/worldcrafter-demo] [--open]

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createApp } from "./src/app.js";
import { DEFAULT_SPACE, SpaceBackend } from "./src/space.js";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT || "7788" },
    data: { type: "string", default: fileURLToPath(new URL("./data/", import.meta.url)) },
    space: { type: "string", default: process.env.WORLDCRAFTER_SPACE || DEFAULT_SPACE },
    open: { type: "boolean", default: false },
  },
});

const handler = createApp({ dataDir: args.data, space: new SpaceBackend({ spaceId: args.space }), spaceId: args.space });
const server = createServer(handler);
server.requestTimeout = 0; // SSE streams stay open for the whole render.

function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${args.port} is busy. Is Explorer already running? Try http://localhost:${args.port} or pass --port.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// Loopback only: this app holds your Hugging Face token and has no login.
server.listen(Number(args.port), "127.0.0.1", () => {
  const url = `http://localhost:${args.port}`;
  console.log(`WorldCrafter Explorer running at ${url}`);
  console.log(`Space: ${args.space}`);
  console.log(`Data:  ${args.data}`);
  console.log("Press Ctrl+C to stop.");
  if (args.open) openBrowser(url);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    handler.cancelActive();
    server.close();
    process.exit(0);
  });
}
