import { readdirSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { PATHS, WHISPER_BIN, PORT, VERSION } from "./config.ts";
import { STT_CATALOG } from "./registry.ts";
import {
  installDiarize, diarizeDir, activeModel,
  DIARIZE_CATALOG, modelInstalled, addDiarizeModel, useDiarizeModel, removeDiarizeModel,
} from "./diarize.ts";

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
  console.log("reload the running server: voiced restart");
}

export function cmdRm(name: string): void {
  const target = listSttFiles().find((m) => m.name === name);
  if (!target) {
    console.error(`not installed: ${name}`);
    process.exit(2);
  }
  unlinkSync(target.file);
  console.log(`removed: ${target.file}`);
  console.log("reload: voiced restart");
}

function cmdDiarizeLs(): void {
  const active = activeModel();
  console.log("Diarization models (✓ installed, ● active):");
  for (const m of DIARIZE_CATALOG) {
    const installed = modelInstalled(m.key);
    let mark = " ";
    if (m.key === active) mark = "●";
    else if (installed) mark = "✓";
    const cap = m.maxSpeakers === null ? "any spk" : `≤${m.maxSpeakers} spk`;
    console.log(`  ${mark} ${m.key.padEnd(18)} ${m.size.padStart(8)}  ${cap.padEnd(8)} ${m.desc}`);
  }
  console.log("\n  add:  voiced diarize add <name>");
  console.log("  use:  voiced diarize use <name>");
}

export async function cmdDiarize(args: string[]): Promise<void> {
  const [sub, name] = args;

  if (sub === "ls") { cmdDiarizeLs(); return; }

  if (sub === "add") {
    if (!name) { console.error("usage: voiced diarize add <name>"); process.exit(2); }
    await addDiarizeModel(name);
    console.log(`installed: ${name}`);
    console.log(`select it with: voiced diarize use ${name}`);
    console.log("then reload: voiced restart");
    return;
  }

  if (sub === "use") {
    if (!name) { console.error("usage: voiced diarize use <name>"); process.exit(2); }
    useDiarizeModel(name);
    console.log(`active diarization model: ${name}`);
    console.log("reload: voiced restart");
    return;
  }

  if (sub === "rm") {
    if (!name) { console.error("usage: voiced diarize rm <name>"); process.exit(2); }
    removeDiarizeModel(name);
    console.log(`removed: ${name}`);
    console.log("reload: voiced restart");
    return;
  }

  if (sub === "install") {
    await installDiarize();
    console.log("enable per request with: diarize=true (full-file mode, response_format=verbose_json)");
    return;
  }

  if (sub === undefined || sub === "status") {
    const active = activeModel();
    console.log(active
      ? `active: ${active}  (dir: ${diarizeDir()})`
      : "no diarization model installed — run: voiced diarize ls");
    return;
  }

  console.error("usage: voiced diarize [ls|add <name>|use <name>|rm <name>|install|status]");
  process.exit(2);
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
  const plist = plistPath();
  checks.push({
    name: "launchd plist",
    ok: existsSync(plist),
    detail: existsSync(plist) ? plist : "not installed — run: voiced start",
  });

  // 6. HTTP endpoint
  const ep = await checkEndpoint();
  checks.push({ name: "HTTP /health", ...ep });

  const col = (s: string, pad: number) => s + " ".repeat(Math.max(0, pad - s.length));
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${col(c.name, 20)} ${c.detail}`);
  }
  const active = activeModel();
  const diarLine = active ? `active: ${active}` : "none (optional) — voiced diarize ls";
  console.log(`  • ${col("diarization", 20)} ${diarLine}`);
  const allOk = checks.every((c) => c.ok);
  process.exit(allOk ? 0 : 1);
}

const LABEL = "io.byteink.voiced";
const LEGACY_LABELS = ["com.byteink.voiced"];

function launchctl(args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
  };
}

function plistPath(): string {
  return `${process.env.HOME}/Library/LaunchAgents/${LABEL}.plist`;
}

function ensureDirs(): void {
  for (const d of [PATHS.home, PATHS.stt, PATHS.tts, PATHS.logs]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  const agents = `${process.env.HOME}/Library/LaunchAgents`;
  if (!existsSync(agents)) mkdirSync(agents, { recursive: true });
}

function purgeLegacyAgents(): void {
  for (const label of LEGACY_LABELS) {
    const p = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;
    if (!existsSync(p)) continue;
    launchctl(["bootout", `gui/${process.getuid?.() ?? ""}/${label}`]);
    unlinkSync(p);
  }
}

function resolveBinPath(): string {
  // Prefer stable brew symlink so the plist survives `brew upgrade voiced`.
  const real = realpathSync(process.execPath);
  for (const candidate of ["/opt/homebrew/bin/voiced", "/usr/local/bin/voiced"]) {
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {}
  }
  return process.execPath;
}

function writePlist(): void {
  const bin = resolveBinPath();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bin}</string>
        <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>VOICED_PORT</key>
        <string>${PORT}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${PATHS.logs}/voiced.out.log</string>
    <key>StandardErrorPath</key>
    <string>${PATHS.logs}/voiced.err.log</string>
    <key>WorkingDirectory</key>
    <string>${PATHS.home}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath(), plist);
}

export function cmdStart(): void {
  ensureDirs();
  purgeLegacyAgents();
  writePlist();
  const r = launchctl(["bootstrap", `gui/${process.getuid?.() ?? ""}`, plistPath()]);
  if (r.code === 0) { console.log("started"); return; }
  if (/already loaded|service already/i.test(r.err)) { console.log("already running"); return; }
  console.error(r.err || `bootstrap failed (${r.code})`);
  process.exit(1);
}

export function cmdStop(): void {
  const r = launchctl(["bootout", `gui/${process.getuid?.() ?? ""}/${LABEL}`]);
  const ok = r.code === 0 || /could not find|no such/i.test(r.err);
  if (existsSync(plistPath())) unlinkSync(plistPath());
  if (ok) { console.log("stopped"); return; }
  console.error(r.err || `bootout failed (${r.code})`);
  process.exit(1);
}

export function cmdRestart(): void {
  ensureDirs();
  purgeLegacyAgents();
  writePlist();
  const uid = process.getuid?.() ?? "";
  const r = launchctl(["kickstart", "-k", `gui/${uid}/${LABEL}`]);
  if (r.code === 0) { console.log("restarted"); return; }
  if (/could not find|no such/i.test(r.err)) {
    const b = launchctl(["bootstrap", `gui/${uid}`, plistPath()]);
    if (b.code === 0) { console.log("started"); return; }
    console.error(b.err || `bootstrap failed (${b.code})`);
    process.exit(1);
  }
  console.error(r.err || `kickstart failed (${r.code})`);
  process.exit(1);
}

export async function cmdStatus(): Promise<void> {
  const r = launchctl(["list"]);
  const line = r.out.split("\n").find((l) => l.includes(LABEL));
  if (!line) { console.log("not loaded"); return; }
  const [pid, exit] = line.split(/\s+/);
  console.log(`launchd: pid=${pid} last_exit=${exit} label=${LABEL}`);
  const ep = await checkEndpoint();
  console.log(`health:  ${ep.ok ? "ok" : "down"} — ${ep.detail}`);
}

export function cmdHelp(): void {
  console.log(`voiced ${VERSION} — OpenAI-compatible local STT gateway

Usage:
  voiced help              Show this message
  voiced version           Print the version
  voiced status            Show launchd + health status
  voiced start             Load the launchd agent
  voiced stop              Unload the launchd agent
  voiced restart           Restart the launchd agent

  voiced ls                List installed + available models
  voiced add <name>        Download a model from the catalogue
  voiced rm <name>         Delete an installed model

  voiced diarize ls        List diarization models (sortformer / sherpa)
  voiced diarize add <name>  Download a diarization model
  voiced diarize use <name>  Select the active diarization model
  voiced diarize rm <name>   Remove a diarization model
  voiced diarize status    Show the active diarization model
  voiced doctor            Check system health (paths, binaries, endpoint)

  voiced serve             Run the HTTP server in foreground (launchd uses this)

Data dir: ${PATHS.home}
Endpoint: http://127.0.0.1:${PORT}
Logs:     ${PATHS.logs}/voiced.{out,err}.log
`);
}
