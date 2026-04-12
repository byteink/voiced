import { readdirSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { PATHS, WHISPER_BIN, PORT } from "./config.ts";
import { STT_CATALOG } from "./registry.ts";

function human(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function listSttFiles(): Array<{ name: string; file: string; bytes: number }> {
  if (!existsSync(PATHS.stt)) return [];
  const out: Array<{ name: string; file: string; bytes: number }> = [];
  for (const f of readdirSync(PATHS.stt)) {
    if (!f.startsWith("ggml-") || !f.endsWith(".bin")) continue;
    const full = join(PATHS.stt, f);
    out.push({ name: f.slice(5, -4), file: full, bytes: statSync(full).size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function cmdLs(): void {
  const installed = listSttFiles();
  console.log("STT models (installed):");
  if (installed.length === 0) {
    console.log("  (none)");
  } else {
    for (const m of installed) console.log(`  ${m.name.padEnd(26)} ${human(m.bytes).padStart(8)}`);
  }

  console.log("\nSTT catalogue (available via `voiced add <name>`):");
  const installedNames = new Set(installed.map((m) => m.name));
  for (const [key, entry] of Object.entries(STT_CATALOG)) {
    const mark = installedNames.has(entry.name) ? "✓" : " ";
    console.log(`  ${mark} ${key.padEnd(22)} ${entry.size.padStart(8)}   ${entry.desc}`);
  }

  console.log("\nTTS voices: (TTS not yet implemented)");
}

export async function cmdAdd(name: string): Promise<void> {
  const entry = STT_CATALOG[name];
  if (!entry) {
    console.error(`unknown model '${name}'. run: voiced ls`);
    process.exit(2);
  }
  if (!existsSync(PATHS.stt)) mkdirSync(PATHS.stt, { recursive: true });
  const dest = join(PATHS.stt, `ggml-${entry.name}.bin`);
  if (existsSync(dest)) {
    console.log(`already installed: ${dest}`);
    return;
  }

  console.log(`downloading ${entry.name} (${entry.size}) → ${dest}`);
  const res = await fetch(entry.url);
  if (!res.ok || !res.body) {
    console.error(`download failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const tmp = `${dest}.partial`;
  const file = Bun.file(tmp);
  const writer = file.writer();
  const reader = res.body.getReader();
  let bytes = 0;
  const started = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    bytes += value.byteLength;
    process.stdout.write(`\r  ${human(bytes)} ...`);
  }
  await writer.end();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\r  ${human(bytes)} in ${elapsed}s\n`);

  await Bun.write(dest, Bun.file(tmp));
  unlinkSync(tmp);
  console.log(`installed: ${dest}`);
  console.log("reload the running server: launchctl kickstart -k gui/$UID/com.user.voiced");
}

export function cmdRm(name: string): void {
  const target = listSttFiles().find((m) => m.name === name);
  if (!target) {
    console.error(`not installed: ${name}`);
    process.exit(2);
  }
  unlinkSync(target.file);
  console.log(`removed: ${target.file}`);
  console.log("reload: launchctl kickstart -k gui/$UID/com.user.voiced");
}

async function checkEndpoint(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await r.text();
    return { ok: r.ok, detail: `HTTP ${r.status} ${body.trim()}` };
  } catch (e) {
    return { ok: false, detail: `not reachable (${(e as Error).message})` };
  }
}

export async function cmdDoctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Home dirs
  for (const [label, path] of Object.entries(PATHS)) {
    checks.push({ name: `path: ${label}`, ok: existsSync(path), detail: path });
  }

  // 2. whisper-server binary
  checks.push({
    name: "whisper-server",
    ok: existsSync(WHISPER_BIN),
    detail: WHISPER_BIN,
  });

  // 3. ffmpeg
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    checks.push({ name: "ffmpeg", ok: proc.exitCode === 0, detail: "available" });
  } catch {
    checks.push({ name: "ffmpeg", ok: false, detail: "not found — brew install ffmpeg" });
  }

  // 4. STT models
  const installed = listSttFiles();
  checks.push({
    name: "STT models",
    ok: installed.length > 0,
    detail: installed.length === 0 ? "none — run: voiced add large-v3-turbo" : `${installed.length} installed`,
  });

  // 5. LaunchAgent
  const plist = `${process.env.HOME}/Library/LaunchAgents/com.user.voiced.plist`;
  checks.push({
    name: "launchd plist",
    ok: existsSync(plist),
    detail: existsSync(plist) ? plist : "not installed — run scripts/install.sh",
  });

  // 6. HTTP endpoint
  const ep = await checkEndpoint();
  checks.push({ name: "HTTP /health", ...ep });

  const col = (s: string, pad: number) => s + " ".repeat(Math.max(0, pad - s.length));
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${col(c.name, 20)} ${c.detail}`);
  }
  const allOk = checks.every((c) => c.ok);
  process.exit(allOk ? 0 : 1);
}

export function cmdHelp(): void {
  console.log(`voiced — OpenAI-compatible local STT gateway

Usage:
  voiced              Start the HTTP server (use launchd in production)
  voiced ls           List installed + available models
  voiced add <name>   Download a model from the catalogue
  voiced rm <name>    Delete an installed model
  voiced doctor       Check system health (paths, binaries, endpoint)
  voiced help         Show this message

Data dir: ${PATHS.home}
Endpoint: http://127.0.0.1:${PORT}
`);
}
