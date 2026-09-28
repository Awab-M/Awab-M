// Hugging Face token lookup. The value never leaves this process except as an
// Authorization header to huggingface.co / hf.space.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class TokenStore {
  constructor(dataDir, env = process.env) {
    this.file = join(dataDir, "settings.json");
    this.env = env;
  }

  async readSettings() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  /** Returns { token, source } using app setting, then env vars, then `hf auth login`'s file. */
  async resolve() {
    const settings = await this.readSettings();
    if (settings.hfToken) return { token: settings.hfToken, source: "saved in this app" };
    for (const name of ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"]) {
      if (this.env[name]) return { token: this.env[name].trim(), source: `${name} environment variable` };
    }
    const hfHome = this.env.HF_HOME || join(homedir(), ".cache", "huggingface");
    try {
      const token = (await readFile(join(hfHome, "token"), "utf8")).trim();
      if (token) return { token, source: "Hugging Face CLI login" };
    } catch {
      // No CLI login on this machine.
    }
    return { token: null, source: null };
  }

  async save(token) {
    const settings = await this.readSettings();
    if (token) settings.hfToken = token;
    else delete settings.hfToken;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }
}

export const maskToken = (token) => (token ? `hf_…${token.slice(-4)}` : null);

/** Ask huggingface.co who owns a token. Returns { ok, user?, error? }. */
export async function whoami(token, fetchImpl = fetch) {
  try {
    const response = await fetchImpl("https://huggingface.co/api/whoami-v2", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) return { ok: false, error: "Hugging Face rejected this token." };
    if (!response.ok) return { ok: false, error: `Hugging Face returned HTTP ${response.status}.`, unverified: true };
    const body = await response.json();
    return { ok: true, user: body.name, pro: body.isPro === true };
  } catch (error) {
    return { ok: false, error: `Could not reach Hugging Face: ${error.message}`, unverified: true };
  }
}
