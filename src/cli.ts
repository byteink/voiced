import { readdirSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { PATHS, WHISPER_BIN, PORT, VERSION } from "./config.ts";
import { LOG_FILE, ERR_FILE, pretty, atLevel, type Level } from "./logger.ts";
import { gateStatus, setLimit } from "./gate.ts";
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

function adminUrl(path: string): string {
  return `http://127.0.0.1:${PORT}${path}`;
}

// Ask the running server to rescan models. Returns a human status, or null when
// the server is down (the file is on disk either way; boot discovers it).
async function triggerReload(): Promise<string | null> {
  try {
    const r = await fetch(adminUrl("/admin/reload"), { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!r.ok) return `server reload failed: HTTP ${r.status}`;
    const j = (await r.json()) as { added: string[]; removed: string[] };
    const parts: string[] = [];
    if (j.added.length) parts.push(`+${j.added.join(", ")}`);
    if (j.removed.length) parts.push(`-${j.removed.join(", ")}`);
    return parts.length ? `loaded live (${parts.join("  ")})` : "loaded live (no change)";
  } catch {
    return null;
  }
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
  console.log(await triggerReload() ?? "voiced not running — it will load on next start");
}

export async function cmdRm(name: string): Promise<void> {
  const target = listSttFiles().find((m) => m.name === name);
  if (!target) {
    console.error(`not installed: ${name}`);
    process.exit(2);
  }
  unlinkSync(target.file);
  console.log(`removed: ${target.file}`);
  console.log(await triggerReload() ?? "voiced not running — no reload needed");
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

function uid(): string {
  return String(process.getuid?.() ?? "");
}

// launchd remembers a per-user disabled flag independently of whether the plist
// exists, and it SURVIVES REBOOTS AND REINSTALLS. A disabled service refuses to
// bootstrap ("Service is disabled"), so every start path clears it first --
// otherwise `voiced disable` once means `voiced start` is broken forever with a
// message that does not say why.
function setEnabled(on: boolean): { code: number; out: string; err: string } {
  return launchctl([on ? "enable" : "disable", `gui/${uid()}/${LABEL}`]);
}

// True when launchd holds the disabled flag for this label.
function isDisabled(): boolean {
  const r = launchctl(["print-disabled", `gui/${uid()}`]);
  return new RegExp(`"${LABEL}"\\s*=>\\s*(disabled|true)`).test(r.out);
}

function isLoaded(): boolean {
  return launchctl(["list"]).out.split("\n").some((l) => l.includes(LABEL));
}

function bootout(): { ok: boolean; err: string } {
  const r = launchctl(["bootout", `gui/${uid()}/${LABEL}`]);
  return { ok: r.code === 0 || /could not find|no such|not find/i.test(r.err), err: r.err };
}

// Run now. Leaves the start-at-login setting alone except for clearing an
// explicit `disable`, which would otherwise make this command fail.
export function cmdStart(): void {
  ensureDirs();
  purgeLegacyAgents();
  writePlist();
  setEnabled(true);
  const r = launchctl(["bootstrap", `gui/${uid()}`, plistPath()]);
  if (r.code === 0) { console.log("started"); return; }
  if (/already loaded|service already/i.test(r.err)) { console.log("already running"); return; }
  console.error(r.err || `bootstrap failed (${r.code})`);
  process.exit(1);
}

// Stop now, and leave it enrolled: it comes back at the next login. Use
// `voiced disable` to stop it coming back. This deliberately no longer deletes
// the plist -- "stop the daemon" and "never run it again" are different asks,
// and conflating them meant there was no way to do the first one.
export function cmdStop(): void {
  const r = bootout();
  if (r.ok) {
    console.log(isDisabled() ? "stopped (start at login: disabled)" : "stopped (starts again at login — `voiced disable` to prevent)");
    return;
  }
  console.error(r.err || "bootout failed");
  process.exit(1);
}

// Start at login, from now on. Also starts it now, so `enable` never leaves the
// user looking at a service that is configured but not running.
export function cmdEnable(): void {
  ensureDirs();
  purgeLegacyAgents();
  writePlist();
  const e = setEnabled(true);
  if (e.code !== 0 && e.err) { console.error(e.err); process.exit(1); }
  if (!isLoaded()) launchctl(["bootstrap", `gui/${uid()}`, plistPath()]);
  console.log("enabled — starts at login, running now");
}

// Do not start at login, and stop it now. The plist stays on disk so `voiced
// enable` restores it without reinstalling anything.
export function cmdDisable(): void {
  const e = setEnabled(false);
  if (e.code !== 0 && e.err) { console.error(e.err); process.exit(1); }
  const r = bootout();
  if (!r.ok) { console.error(r.err || "bootout failed"); process.exit(1); }
  console.log("disabled — stopped, and will not start at login");
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
  const atLogin = isDisabled() ? "disabled" : "enabled";
  const r = launchctl(["list"]);
  const line = r.out.split("\n").find((l) => l.includes(LABEL));
  if (!line) {
    console.log(`launchd: not loaded  (start at login: ${atLogin})`);
    return;
  }
  const [pid, exit] = line.split(/\s+/);
  console.log(`launchd: pid=${pid} last_exit=${exit} label=${LABEL}  (start at login: ${atLogin})`);
  const ep = await checkEndpoint();
  console.log(`health:  ${ep.ok ? "ok" : "down"} — ${ep.detail}`);
}

type LogOpts = { follow: boolean; json: boolean; file: string; lines: number; level: Level | null };

function parseLogArgs(args: string[]): LogOpts {
  const o: LogOpts = { follow: false, json: false, file: LOG_FILE, lines: 100, level: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--follow") o.follow = true;
    else if (a === "--json") o.json = true;
    else if (a === "--err") o.file = ERR_FILE;
    else if (a === "-l" || a === "-n" || a === "--lines") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) { console.error("usage: voiced log -l <positive number>"); process.exit(2); }
      o.lines = Math.floor(n);
    } else if (a === "--level") {
      const v = args[++i];
      if (v !== "info" && v !== "warn" && v !== "error") { console.error("usage: voiced log --level info|warn|error"); process.exit(2); }
      o.level = v;
    } else { console.error(`unknown log option: ${a}`); process.exit(2); }
  }
  return o;
}

// Last `n` lines across the active file and any rotated siblings (.1, .2, …),
// oldest-first. Only the structured log rotates, so the err log yields one file.
function tailFiles(file: string, n: number): string[] {
  const files = [file];
  for (let i = 1; i <= 1000 && existsSync(`${file}.${i}`); i++) files.push(`${file}.${i}`);
  let need = n;
  const chunks: string[][] = [];
  for (const f of files) {
    if (need <= 0) break;
    const all = readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0);
    const take = all.slice(Math.max(0, all.length - need));
    chunks.unshift(take);
    need -= take.length;
  }
  return chunks.flat();
}

// Follow via `tail -F`: it is battle-tested for rotation, truncation and partial
// lines — we only pretty-print its output. Loop ends when tail is killed.
async function followLog(o: LogOpts, render: (raw: string) => string | null): Promise<void> {
  const proc = Bun.spawn(["tail", "-n", String(o.lines), "-F", o.file], { stdout: "pipe", stderr: "ignore" });
  const stop = () => { try { proc.kill(); } catch {} process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      if (line.length === 0) continue;
      const out = render(line);
      if (out !== null) console.log(out);
    }
  }
}

export async function cmdLog(args: string[]): Promise<void> {
  const o = parseLogArgs(args);
  const render = (raw: string): string | null => {
    if (o.level && !atLevel(raw, o.level)) return null;
    return o.json ? raw : pretty(raw);
  };

  if (o.follow) { await followLog(o, render); return; }

  if (!existsSync(o.file)) { console.error(`no log file yet: ${o.file}`); return; }
  for (const raw of tailFiles(o.file, o.lines)) {
    const out = render(raw);
    if (out !== null) console.log(out);
  }
}

// `voiced limit` shows it; `voiced limit N` sets it live on the running server
// (persisted, no restart). With the server down, N is saved for the next start.
export async function cmdLimit(args: string[]): Promise<void> {
  const [val] = args;
  if (val === undefined) {
    try {
      const r = await fetch(adminUrl("/admin/limit"), { signal: AbortSignal.timeout(2000) });
      const s = (await r.json()) as { inFlight: number; limit: number };
      console.log(`limit: ${s.limit}   in-flight: ${s.inFlight}`);
    } catch {
      console.log(`limit: ${gateStatus().limit}   (voiced not running)`);
    }
    return;
  }
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) { console.error("usage: voiced limit <positive integer>"); process.exit(2); }
  try {
    const r = await fetch(adminUrl("/admin/limit"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: n }), signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) { console.error(`failed: HTTP ${r.status} ${(await r.text()).trim()}`); process.exit(1); }
    const s = (await r.json()) as { limit: number };
    console.log(`limit set to ${s.limit} (live, no restart)`);
  } catch {
    setLimit(n);
    console.log(`voiced not running — limit ${n} saved; applies on next start`);
  }
}

export async function cmdReload(): Promise<void> {
  const status = await triggerReload();
  if (status === null) { console.error("voiced is not running"); process.exit(1); }
  console.log(status);
}

export function cmdHelp(): void {
  console.log(`voiced ${VERSION} — OpenAI-compatible local STT gateway

Usage:
  voiced help              Show this message
  voiced version           Print the version
  voiced status            Show launchd + health status
  voiced start             Start the daemon now
  voiced stop              Stop the daemon now (still starts at login)
  voiced restart           Restart the daemon
  voiced enable            Start at login (and start now)
  voiced disable           Do not start at login (and stop now)
  voiced log [-f] [-l N]   Show logs (-f follow, -l lines, --json, --level, --err)

  voiced ls                List installed + available models
  voiced add <name>        Download a model (loads live, no restart)
  voiced rm <name>         Delete an installed model (live)
  voiced reload            Rescan models into the running server
  voiced limit [N]         Show or set max concurrent requests (live)

  voiced diarize ls        List diarization models (sortformer / sherpa)
  voiced diarize add <name>  Download a diarization model
  voiced diarize use <name>  Select the active diarization model
  voiced diarize rm <name>   Remove a diarization model
  voiced diarize status    Show the active diarization model
  voiced doctor            Check system health (paths, binaries, endpoint)

  voiced serve             Run the HTTP server in foreground (launchd uses this)

Data dir: ${PATHS.home}
Endpoint: http://127.0.0.1:${PORT}
Logs:     voiced log  (raw: ${PATHS.logs}/voiced.log)
`);
}
