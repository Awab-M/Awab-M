// Saved renders: data/runs/<id>/{video.mp4, input.png, meta.json}.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const RUN_ID = /^[0-9a-z]{8,12}-[0-9a-f]{6}$/;

export class RunStore {
  constructor(dataDir) {
    this.root = join(dataDir, "runs");
  }

  dir(id) {
    if (!RUN_ID.test(id)) throw new Error("Invalid run id");
    return join(this.root, id);
  }

  newId() {
    return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  }

  async save(meta, { video, image, imageExt = "png" }) {
    const id = meta.id ?? this.newId();
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "video.mp4"), video);
    const record = { ...meta, id, video: "video.mp4" };
    if (image) {
      record.input = `input.${imageExt}`;
      await writeFile(join(dir, record.input), image);
    }
    await writeFile(join(dir, "meta.json"), JSON.stringify(record, null, 2));
    return record;
  }

  async get(id) {
    return JSON.parse(await readFile(join(this.dir(id), "meta.json"), "utf8"));
  }

  async list() {
    let names = [];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const runs = [];
    for (const name of names.filter((n) => RUN_ID.test(n))) {
      try {
        runs.push(await this.get(name));
      } catch {
        // Half-written or foreign folder; skip it.
      }
    }
    return runs.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }

  async remove(id) {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}
