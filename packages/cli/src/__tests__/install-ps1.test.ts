import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixture = Buffer.from("#!/usr/bin/env node\nconsole.log('asr stub');\n");
const correctHash = createHash("sha256").update(fixture).digest("hex");
const wrongHash = "0".repeat(64);

let server: Server;
let baseUrl: string;
let shaPayload = `${correctHash}  asr.mjs\n`;

const scriptPath = join(__dirname, "..", "..", "..", "..", "scripts", "install.ps1");

function which(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

const canRun = which("pwsh");

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function runInstall(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-File", scriptPath], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe.skipIf(!canRun)("scripts/install.ps1", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/org/aks/releases/latest/download/asr.mjs") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(fixture);
        return;
      }
      if (req.url === "/org/aks/releases/latest/download/asr.mjs.sha256") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(shaPayload);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("installs the launcher when the SHA-256 matches", async () => {
    shaPayload = `${correctHash}  asr.mjs\n`;
    const dest = mkdtempSync(join(tmpdir(), "asr-install-ps-ok-"));
    try {
      const result = await runInstall({
        ...process.env,
        ASR_FORGEJO_URL: baseUrl,
        ASR_INSTALL_DIR: dest,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      const shim = join(dest, "asr.cmd");
      const bundle = join(dest, "asr.mjs");
      expect(existsSync(shim)).toBe(true);
      expect(existsSync(bundle)).toBe(true);
      expect(existsSync(join(dest, "asr.mjs.sha256"))).toBe(false);
      expect(readFileSync(shim, "utf8")).toContain("node \"%~dp0asr.mjs\" %*");
      expect(readFileSync(bundle).equals(fixture)).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("aborts and leaves no bundle when the SHA-256 does not match", async () => {
    shaPayload = `${wrongHash}  asr.mjs\n`;
    const dest = mkdtempSync(join(tmpdir(), "asr-install-ps-bad-"));
    try {
      const result = await runInstall({
        ...process.env,
        ASR_FORGEJO_URL: baseUrl,
        ASR_INSTALL_DIR: dest,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("SHA-256 mismatch");
      expect(existsSync(join(dest, "asr.mjs"))).toBe(false);
      expect(existsSync(join(dest, "asr.mjs.sha256"))).toBe(false);
      expect(existsSync(join(dest, "asr.cmd"))).toBe(false);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
