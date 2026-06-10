// Single owner of request admission control. Nothing else in the app counts
// in-flight work or decides when to shed load — every gated request funnels
// through withGate(). This is the one chokepoint on purpose.
//
// Reject-when-full (no internal queue): at capacity we return 503 immediately so
// callers get backpressure instead of an unbounded wait. The cap exists to stop
// the diarize path from fork-bombing the host (one ffmpeg + one ~492MB diarizer
// process per request) and to give the serialized whisper path a fast-fail
// ceiling instead of a silent pile-up.
//
// The limit reads initially from VOICED_MAX_CONCURRENCY (default 4), but a CLI
// change via setLimit() applies live and persists to ~/.voiced/limit so it
// sticks across restarts without editing the launchd plist. Precedence:
// persisted file > env > default.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.ts";

const LIMIT_FILE = join(PATHS.home, "limit");

function envInt(name: string, dflt: number): number {
  const n = Number(Bun.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function loadLimit(): number {
  try {
    const n = Number(readFileSync(LIMIT_FILE, "utf8").trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {}
  return envInt("VOICED_MAX_CONCURRENCY", 4);
}

let limit = loadLimit();
let inFlight = 0;

// Update the live limit and persist it. Safe to call from the CLI process when
// the server is down — it just writes the file the next boot reads.
export function setLimit(n: number): void {
  limit = Math.floor(n);
  try { writeFileSync(LIMIT_FILE, `${limit}\n`); } catch {}
}

// Read-only view for /health, `voiced limit`, and diagnostics. Exposing state is
// not control — the counter is only ever mutated inside withGate.
export function gateStatus(): { inFlight: number; limit: number } {
  return { inFlight, limit };
}

function busy(): Response {
  return new Response(
    JSON.stringify({ error: { message: `server at capacity (${limit} concurrent); retry shortly`, type: "overloaded_error", code: "busy" } }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } },
  );
}

// Admit and run `work`, or return 503 if already at capacity. The permit is
// always released — success, handler error, or client abort — via finally, so a
// permit can never leak.
export async function withGate(work: () => Promise<Response>): Promise<Response> {
  if (inFlight >= limit) return busy();
  inFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
  }
}
