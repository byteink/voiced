// Structured, self-rotating application log. The `serve` process is the single
// writer (guarded by the pid lock), so no locking is needed. Each line is one
// JSON object; `voiced log` renders them for humans.
//
// Rotation is pm2-logrotate style: when the active file would exceed the size
// cap it is renamed to `.1` (shifting `.1`->`.2`, …) and a fresh file is opened.
// The file beyond the retain count is deleted, so disk is bounded at roughly
// MAX_BYTES * (RETAIN + 1).

import { openSync, writeSync, closeSync, fstatSync, existsSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.ts";

export type Level = "info" | "warn" | "error";

// The structured log; ERR_FILE is the raw whisper/crash capture (launchd-owned).
export const LOG_FILE = join(PATHS.logs, "voiced.log");
export const ERR_FILE = join(PATHS.logs, "voiced.err.log");

function envInt(name: string, dflt: number): number {
  const n = Number(Bun.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

const MAX_BYTES = envInt("VOICED_LOG_MAX_SIZE", 10 * 1024 * 1024);
const RETAIN = envInt("VOICED_LOG_RETAIN", 5);
const TTY = process.stdout.isTTY === true;

let fd = -1;
let written = 0;

function openLog(): void {
  if (fd >= 0) return;
  if (!existsSync(PATHS.logs)) mkdirSync(PATHS.logs, { recursive: true });
  fd = openSync(LOG_FILE, "a");
  written = fstatSync(fd).size;
}

function rotate(): void {
  closeSync(fd);
  fd = -1;
  rmSync(`${LOG_FILE}.${RETAIN}`, { force: true });
  for (let i = RETAIN - 1; i >= 1; i--) {
    const from = `${LOG_FILE}.${i}`;
    if (existsSync(from)) renameSync(from, `${LOG_FILE}.${i + 1}`);
  }
  renameSync(LOG_FILE, `${LOG_FILE}.1`);
  openLog();
}

export function log(evt: string, fields: Record<string, unknown> = {}, lvl: Level = "info"): void {
  const buf = Buffer.from(JSON.stringify({ ts: new Date().toISOString(), lvl, evt, ...fields }) + "\n");
  openLog();
  // `written > 0` keeps a single oversized line from rotating an empty file
  // forever; it is written as-is and rotated out on the next call.
  if (written > 0 && written + buf.byteLength > MAX_BYTES) rotate();
  written += writeSync(fd, buf);
  if (TTY) process.stdout.write(buf);
}

// Render one stored line for reading. Non-JSON input (the raw whisper output in
// the err log) passes through untouched.
export function pretty(raw: string): string {
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw); } catch { return raw; }
  const ts = typeof o.ts === "string" ? o.ts.slice(11, 19) : "--:--:--";
  const lvl = String(o.lvl ?? "info").toUpperCase().padEnd(5);
  const evt = String(o.evt ?? "?").padEnd(9);
  const rest = Object.entries(o)
    .filter(([k]) => k !== "ts" && k !== "lvl" && k !== "evt")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `${ts} ${lvl} ${evt} ${rest}`.trimEnd();
}

const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };

// True when a stored line is at or above `min`. Non-JSON lines have no level and
// are always shown.
export function atLevel(raw: string, min: Level): boolean {
  try {
    const lvl = (JSON.parse(raw) as { lvl?: Level }).lvl ?? "info";
    return RANK[lvl] >= RANK[min];
  } catch {
    return true;
  }
}
