// Official WorldCrafter example scenes, fetched on demand from the Space repo and
// cached under data/examples. Nothing is bundled with this app.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const NAME = /^[0-9A-Za-z_-]{1,64}$/;

export class Examples {
  constructor(dataDir, { spaceId, fetchImpl = fetch } = {}) {
    this.root = join(dataDir, "examples");
    this.base = `https://huggingface.co/spaces/${spaceId}/resolve/main/examples`;
    this.tree = `https://huggingface.co/api/spaces/${spaceId}/tree/main/examples`;
    this.fetch = fetchImpl;
    this.listing = null;
  }

  async cached(rel, load) {
    const file = join(this.root, rel);
    try {
      return await readFile(file);
    } catch {
      const data = await load();
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, data);
      return data;
    }
  }

  async download(url) {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async text(mode, name, file) {
    try {
      return (await this.cached(`${mode}/${name}/${file}`, () => this.download(`${this.base}/${mode}/${name}/${file}`))).toString("utf8").trim();
    } catch {
      return "";
    }
  }

  /** [{ mode, name, label, prompt, actions }] for I2V and T2V. */
  async list() {
    if (this.listing) return this.listing;
    const out = [];
    for (const mode of ["I2V", "T2V"]) {
      const raw = await this.cached(`${mode}/index.json`, () => this.download(`${this.tree}/${mode}`));
      const dirs = JSON.parse(raw.toString("utf8")).filter((e) => e.type === "directory").map((e) => e.path.split("/").pop());
      for (const name of dirs.filter((n) => NAME.test(n))) {
        const [prompt, actions] = await Promise.all([this.text(mode, name, "prompt.txt"), this.text(mode, name, "actions.txt")]);
        if (prompt && actions) {
          out.push({ mode: mode.toLowerCase(), name, label: name.replace(/^\d+_/, "").replaceAll("_", " "), prompt, actions });
        }
      }
    }
    this.listing = out;
    return out;
  }

  async image(name) {
    if (!NAME.test(name)) throw new Error("Invalid example name");
    return this.cached(`I2V/${name}/image.png`, () => this.download(`${this.base}/I2V/${name}/image.png`));
  }
}
