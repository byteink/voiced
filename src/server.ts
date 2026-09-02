// voiced HTTP server + supervisor for native STT children.

import { spawn, type Subprocess } from "bun";
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PATHS, PORT, BASE_PORT, WHISPER_BIN, THREADS, STT_ALIASES, IDLE_MS, SPAWN_TIMEOUT_MS } from "./config.ts";
import { diarizeInstalled, runDiarization, speakerForSegment } from "./diarize.ts";
import { log } from "./logger.ts";
import { withGate, gateStatus, setLimit } from "./gate.ts";

// A model installed on disk. Its port is assigned once, at discovery, and kept
// for the life of the process so a model always reappears on the same port.
type Known = { name: string; path: string; port: number };

// A running whisper-server. `inflight` counts requests currently using it;
// eviction may only happen at zero, or a decode in progress would be killed.
type Child = {
  name: string; port: number; path: string; proc: Subprocess;
  inflight: number; idle: ReturnType<typeof setTimeout> | null;
};

// Per-request log context: a short id shared by the request's req.start/req.end
// lines, plus fields the handler enriches (model, bytes, cancellation, …).
// `local` is true when the connection came from loopback — it gates /admin/*.
type ReqCtx = { id: string; fields: Record<string, unknown>; local: boolean };

const known = new Map<string, Known>();
const children = new Map<string, Child>();
// In-flight spawns, keyed by model name. Two requests arriving together for an
// unloaded model must await ONE spawn, not race two whisper-servers onto the
// same port.
const starting = new Map<string, Promise<Child | null>>();
let shuttingDown = false;

function discoverSttModels(): Array<{ name: string; path: string }> {
  if (!existsSync(PATHS.stt)) return [];
  const entries = readdirSync(PATHS.stt);
  const models: Array<{ name: string; path: string }> = [];
  for (const f of entries) {
    if (!f.startsWith("ggml-") || !f.endsWith(".bin")) continue;
    models.push({ name: f.slice(5, -4), path: join(PATHS.stt, f) });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}

function spawnChild(modelPath: string, port: number): Subprocess {
  return spawn({
    cmd: [
      WHISPER_BIN,
      "-m", modelPath,
      "--host", "127.0.0.1",
      "--port", String(port),
      "-l", "auto",
      "--convert",
      "--tmp-dir", "/tmp",
      "-t", THREADS,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
}

// Stop a child and forget it. Deleting from the map FIRST is what tells the
// exit handler this was deliberate, so it does not respawn what we just evicted.
function stopChild(name: string, why: string) {
  const c = children.get(name);
  if (!c) return;
  children.delete(name);
  if (c.idle) clearTimeout(c.idle);
  try { c.proc.kill("SIGTERM"); } catch {}
  log("child-stop", { name, why });
}

function clearIdle(c: Child) {
  if (c.idle) { clearTimeout(c.idle); c.idle = null; }
}

// Arm the idle timer, but only when nothing is using the child. Called on every
// release; the guard is what makes a burst of requests hold the model open.
function armIdle(c: Child) {
  clearIdle(c);
  if (IDLE_MS <= 0 || c.inflight > 0) return;
  c.idle = setTimeout(() => {
    // Re-check under the timer: a request may have arrived in the gap.
    const live = children.get(c.name);
    if (!live || live !== c || live.inflight > 0) return;
    stopChild(c.name, "idle");
  }, IDLE_MS);
}

// Bracket one request's use of a child. The release must run on every path,
// including a throw or a client cancel, or the model is pinned in memory for
// the life of the daemon -- which is the whole bug this exists to fix.
async function withChild<T>(c: Child, fn: () => Promise<T>): Promise<T> {
  c.inflight++;
  clearIdle(c);
  try {
    return await fn();
  } finally {
    c.inflight--;
    armIdle(c);
  }
}

function supervise(name: string, modelPath: string, port: number): Child {
  const proc = spawnChild(modelPath, port);
  const child: Child = { name, port, path: modelPath, proc, inflight: 0, idle: null };
  children.set(name, child);
  proc.exited.then((code: number | null) => {
    log("child-exit", { name, code });
    // Respawn only a genuine crash: if the child was intentionally removed (or
    // replaced) its map entry is gone or holds a different proc, so we stop.
    // An evicted child took the `children.delete` path, so it lands here too.
    if (!shuttingDown && children.get(name)?.proc === proc) {
      children.delete(name);
      setTimeout(() => { if (!shuttingDown && known.has(name)) void ensureChild(name); }, 2000);
    }
  });
  return child;
}

// Get a running child for `name`, spawning and waiting for readiness if it is
// not loaded. Concurrent callers for the same name share one spawn.
async function ensureChild(name: string): Promise<Child | null> {
  const live = children.get(name);
  if (live) { clearIdle(live); return live; }

  const pending = starting.get(name);
  if (pending) return pending;

  const k = known.get(name);
  if (!k) return null;

  const p = (async (): Promise<Child | null> => {
    const started = Date.now();
    log("child-spawn", { name, port: k.port });
    const child = supervise(k.name, k.path, k.port);
    const ready = await waitReady(k.port, SPAWN_TIMEOUT_MS);
    if (!ready) {
      stopChild(name, "spawn-timeout");
      log("child-spawn-failed", { name, ms: Date.now() - started }, "error");
      return null;
    }
    log("child-ready", { name, ms: Date.now() - started });
    armIdle(child);
    return child;
  })().finally(() => starting.delete(name));

  starting.set(name, p);
  return p;
}

// Resolve a requested model name (or the default) to an INSTALLED model. This
// deliberately answers from `known`, not from what happens to be running -- a
// model being unloaded is an implementation detail, not a 404.
function resolveKnown(requested: string | null): Known | null {
  if (!requested) {
    const preferred = known.get(STT_ALIASES["whisper-1"] ?? "");
    return preferred ?? known.values().next().value ?? null;
  }
  const name = STT_ALIASES[requested] ?? requested;
  return known.get(name) ?? null;
}

// Lowest port at/above BASE_PORT not already assigned to a known model.
function nextFreePort(): number {
  const used = new Set([...known.values()].map((k) => k.port));
  let p = BASE_PORT;
  while (used.has(p)) p++;
  return p;
}

// Converge the KNOWN model set to what is on disk: register anything newly
// added, forget anything whose file is gone and stop it if it happens to be
// running. Registering does not load a model -- that happens on first use --
// so `voiced add` is now free in memory terms. The sole mutator of the model
// set outside boot; `voiced add`/`rm` reach it via POST /admin/reload, so
// models change without a restart.
function reloadModels(): { added: string[]; removed: string[]; models: string[] } {
  const found = discoverSttModels();
  const names = new Set(found.map((m) => m.name));
  const added: string[] = [];
  const removed: string[] = [];
  for (const m of found) {
    if (known.has(m.name)) continue;
    known.set(m.name, { name: m.name, path: m.path, port: nextFreePort() });
    added.push(m.name);
  }
  // Snapshot before mutating: deleting from the live map mid-iteration skips
  // entries.
  const gone = [...known.keys()].filter((name) => !names.has(name));
  for (const name of gone) {
    known.delete(name);
    stopChild(name, "removed");
    removed.push(name);
  }
  if (added.length || removed.length) log("reload", { added, removed });
  return { added, removed, models: [...known.keys()] };
}

async function waitReady(port: number, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      if (res.status < 500) return true;
    } catch {}
    await Bun.sleep(250);
  }
  return false;
}

function jsonError(status: number, code: string, message: string) {
  return new Response(
    JSON.stringify({ error: { message, type: "invalid_request_error", code } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

// A rejection caused by the client going away. fetch reports this as a
// DOMException in some runtimes and a plain Error in others, so match on the
// name (the stable contract), never on the class.
function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

// The client closed the connection mid-request. The response is discarded by the
// runtime, so the body is irrelevant; 499 (nginx "Client Closed Request") flows
// through to the req.end access line. `reason` records which stage caught it.
function clientClosed(ctx: ReqCtx, reason: string): Response {
  ctx.fields.cancelled = reason;
  return new Response(null, { status: 499 });
}

async function handleModels(): Promise<Response> {
  const data = [...known.keys()].map((id) => ({
    id, object: "model", created: 0, owned_by: "voiced",
  }));
  for (const alias of Object.keys(STT_ALIASES)) {
    if (known.has(STT_ALIASES[alias])) {
      data.push({ id: alias, object: "model", created: 0, owned_by: "voiced" });
    }
  }
  return Response.json({ object: "list", data });
}

async function handleTranscribe(req: Request, ctx: ReqCtx): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  // Bun aborts this when the client disconnects; it is the single cancellation
  // source threaded through every stage below.
  const signal = req.signal;

  let inForm: FormData;
  try {
    inForm = await req.formData();
  } catch (err) {
    if (isAbort(err)) return clientClosed(ctx, "upload");
    return jsonError(400, "invalid_form", `could not read multipart form: ${(err as Error).message}`);
  }
  const file = inForm.get("file");
  if (!(file instanceof Blob)) return jsonError(400, "missing_file", "file is required");

  const requested = inForm.get("model");
  const k = resolveKnown(typeof requested === "string" ? requested : null);
  if (!k) {
    return jsonError(404, "model_not_found",
      `model '${String(requested)}' not installed. available: ${[...known.keys()].join(", ")}`);
  }

  // Load on demand. A cold model reads gigabytes off disk, so this is the one
  // place a request can block for seconds; `ms_load` records how long.
  const loadStart = Date.now();
  const wasLoaded = children.has(k.name);
  const child = await ensureChild(k.name);
  if (!child) {
    return jsonError(503, "model_unavailable",
      `model '${k.name}' failed to start within ${SPAWN_TIMEOUT_MS}ms`);
  }
  if (!wasLoaded) ctx.fields.ms_load = Date.now() - loadStart;
  ctx.fields.model = k.name;

  return withChild(child, () => {
    if (isTruthy(inForm.get("diarize"))) return transcribeWithDiarization(inForm, file, child, signal, ctx);
    return proxyTranscribe(inForm, file, child, signal, ctx);
  });
}

// POST to a child's /inference, retrying a CONNECTION-level failure.
//
// whisper-server serves one inference at a time on a single accept loop, so a
// sibling request arriving while it is busy -- most likely right after a cold
// spawn, when the first decode also pays Metal and model init -- is REFUSED at
// the socket, not queued. Measured: 4 concurrent requests against a warm child
// all succeed; the same 4 against a cold one returned 1 success and 3
// "Unable to connect". Retrying is correct here precisely because the peer is
// a local child we already waited for and know is up.
//
// Only connection failures are retried. An HTTP response of any status is the
// child answering, and an abort is the client leaving; neither is retryable.
async function postInference(
  child: Child, body: FormData, signal: AbortSignal,
): Promise<{ res: Response } | { abort: true } | { err: Error }> {
  const url = `http://127.0.0.1:${child.port}/inference`;
  let last: Error | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal.aborted) return { abort: true };
    try {
      return { res: await fetch(url, { method: "POST", body, signal }) };
    } catch (err) {
      if (isAbort(err)) return { abort: true };
      last = err as Error;
      // 250ms, 500ms, 1s, 2s, 4s -- ~7.75s total, comfortably longer than a
      // first decode, and bounded so a genuinely dead child still reports.
      await Bun.sleep(250 * 2 ** attempt);
    }
  }
  return { err: last ?? new Error("unreachable") };
}

// Default (non-diarize) path: proxy straight to the child whisper-server.
// Forwarding the abort frees this handler and closes the proxy connection at
// once. whisper.cpp's current decode on the shared server still runs to the end
// — cpp-httplib cannot interrupt an in-flight handler — so the model frees up
// one decode later, not instantly. The subprocess paths are fully killable.
async function proxyTranscribe(inForm: FormData, file: Blob, child: Child, signal: AbortSignal, ctx: ReqCtx): Promise<Response> {
  const out = new FormData();
  out.append("file", file, (file as File).name ?? "audio");
  for (const key of ["language", "prompt", "temperature", "response_format"] as const) {
    const v = inForm.get(key);
    if (typeof v === "string" && v.length > 0) out.append(key, v);
  }
  if (!inForm.has("response_format")) out.append("response_format", "json");

  const attempt = await postInference(child, out, signal);
  if ("abort" in attempt) return clientClosed(ctx, "upstream-fetch");
  if ("err" in attempt) {
    return jsonError(502, "upstream_unreachable",
      `whisper-server for '${child.name}' not reachable: ${attempt.err.message}`);
  }
  const upstream: Response = attempt.res;

  let body: ArrayBuffer;
  try {
    body = await upstream.arrayBuffer();
  } catch (err) {
    if (isAbort(err)) return clientClosed(ctx, "upstream-read");
    return jsonError(502, "upstream_read_failed",
      `reading whisper-server response failed: ${(err as Error).message}`);
  }
  ctx.fields.model = child.name;
  ctx.fields.bytes = body.byteLength;
  ctx.fields.diarize = false;
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

function isTruthy(v: FormDataEntryValue | null): boolean {
  return typeof v === "string" && /^(1|true|yes|on)$/i.test(v.trim());
}

function parsePositiveInt(v: FormDataEntryValue | null): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Transcribe the child whisper-server on a pre-converted wav, returning the
// parsed verbose_json document or a pass-through error Response.
async function transcribeWav(
  wavPath: string,
  inForm: FormData,
  child: Child,
  signal: AbortSignal,
): Promise<{ ok: true; doc: { segments?: Array<{ start: number; end: number; speaker?: string }> } } | { ok: false; res: Response }> {
  const out = new FormData();
  out.append("file", Bun.file(wavPath), "audio.wav");
  for (const key of ["language", "prompt", "temperature"] as const) {
    const v = inForm.get(key);
    if (typeof v === "string" && v.length > 0) out.append(key, v);
  }
  out.append("response_format", "verbose_json");

  const attempt = await postInference(child, out, signal);
  if ("abort" in attempt) {
    // unwound centrally by transcribeWithDiarization
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }
  if ("err" in attempt) {
    return { ok: false, res: jsonError(502, "upstream_unreachable",
      `whisper-server for '${child.name}' not reachable: ${attempt.err.message}`) };
  }
  const upstream: Response = attempt.res;
  if (!upstream.ok) {
    const errBody = await upstream.arrayBuffer();
    return { ok: false, res: new Response(errBody, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    }) };
  }
  return { ok: true, doc: await upstream.json() };
}

// Decode arbitrary input audio to 16 kHz mono PCM wav — sherpa requires it and
// whisper-server accepts it directly. ffmpeg is killed on disconnect so a
// cancelled decode reclaims CPU at once. Returns null on success, otherwise a
// ready error Response (including the client-cancelled case).
async function decodeToWav(inPath: string, wavPath: string, signal: AbortSignal, ctx: ReqCtx): Promise<Response | null> {
  const ff = spawn({
    cmd: ["ffmpeg", "-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath],
    stdout: "ignore", stderr: "pipe",
  });
  const killFf = () => { try { ff.kill("SIGKILL"); } catch {} };
  signal.addEventListener("abort", killFf, { once: true });
  try {
    await ff.exited;
  } finally {
    signal.removeEventListener("abort", killFf);
  }
  if (signal.aborted) return clientClosed(ctx, "ffmpeg");
  if (ff.exitCode !== 0) {
    const err = (await new Response(ff.stderr).text()).trim().split("\n").at(-1) ?? "unknown";
    return jsonError(400, "audio_decode_failed", `ffmpeg could not decode audio: ${err}`);
  }
  return null;
}

// diarize=true path: normalise audio once, transcribe and diarize the same wav,
// then tag each verbose_json segment with the overlapping speaker. The default
// (no diarize) path above is untouched and byte-identical to upstream.
async function transcribeWithDiarization(inForm: FormData, file: Blob, child: Child, signal: AbortSignal, ctx: ReqCtx): Promise<Response> {
  if (!diarizeInstalled()) {
    return jsonError(503, "diarization_unavailable", "diarization not installed. run: voiced diarize install");
  }
  const rf = inForm.get("response_format");
  if (typeof rf === "string" && rf.length > 0 && rf !== "verbose_json") {
    return jsonError(400, "unsupported_response_format", "diarize=true requires response_format=verbose_json");
  }
  const numSpeakers = parsePositiveInt(inForm.get("num_speakers"));

  const tmp = crypto.randomUUID();
  const inPath = `/tmp/voiced-${tmp}.in`;
  const wavPath = `/tmp/voiced-${tmp}.wav`;
  try {
    if (signal.aborted) return clientClosed(ctx, "diarize-start");
    await Bun.write(inPath, file);

    const decodeErr = await decodeToWav(inPath, wavPath, signal, ctx);
    if (decodeErr) return decodeErr;

    // Both stages take the abort: the diarizer subprocess is killed outright; the
    // whisper proxy connection is torn down (its shared decode finishes upstream).
    // A rejection from either unwinds to the abort branch of the catch below.
    const [whisper, ranges] = await Promise.all([
      transcribeWav(wavPath, inForm, child, signal),
      runDiarization(wavPath, { numSpeakers, signal }),
    ]);
    if (!whisper.ok) return whisper.res;

    const doc = whisper.doc;
    if (Array.isArray(doc.segments)) {
      for (const seg of doc.segments) {
        seg.speaker = speakerForSegment(seg.start, seg.end, ranges) ?? "SPEAKER_00";
      }
    }
    ctx.fields.model = child.name;
    ctx.fields.segments = doc.segments?.length ?? 0;
    ctx.fields.speakers = new Set(ranges.map((r) => r.speaker)).size;
    ctx.fields.diarize = true;
    return Response.json(doc);
  } catch (err) {
    if (isAbort(err)) return clientClosed(ctx, "diarize");
    return jsonError(502, "diarization_failed", (err as Error).message);
  } finally {
    for (const p of [inPath, wavPath]) { try { unlinkSync(p); } catch {} }
  }
}

async function handleHealth(): Promise<Response> {
  const upstreams: Record<string, boolean> = {};
  await Promise.all([...children.values()].map(async (c) => {
    try {
      const r = await fetch(`http://127.0.0.1:${c.port}/`, { signal: AbortSignal.timeout(1500) });
      upstreams[c.name] = r.status < 500;
    } catch {
      upstreams[c.name] = false;
    }
  }));
  // Idle is the normal steady state now, so "no children running" is healthy.
  // What would be broken is having no model INSTALLED, or a loaded child that
  // stopped answering.
  const ok = Object.values(upstreams).every(Boolean) && known.size > 0;
  return new Response(JSON.stringify({
    ok,
    models: [...known.keys()],
    loaded: [...children.keys()],
    upstreams,
    ...gateStatus(),
  }), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

function handleSpeechStub(): Response {
  return jsonError(501, "not_implemented", "TTS (/v1/audio/speech) not yet available");
}

// /admin/* mutate server state (limit, model children). The server binds
// 0.0.0.0, so these are restricted to loopback — an off-host caller cannot forge
// a 127.0.0.1 source address over TCP. Returns the rejection or null to proceed.
function requireLocal(ctx: ReqCtx): Response | null {
  return ctx.local ? null : jsonError(403, "forbidden", "admin endpoints are loopback-only");
}

// GET: current limit + in-flight. POST {value:N}: set the live limit (no
// restart) and persist it.
async function handleAdminLimit(req: Request, ctx: ReqCtx): Promise<Response> {
  const denied = requireLocal(ctx);
  if (denied) return denied;
  if (req.method === "GET") return Response.json(gateStatus());
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use GET or POST");
  const body = (await req.json().catch(() => null)) as { value?: unknown } | null;
  const n = typeof body?.value === "number" ? body.value : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) return jsonError(400, "invalid_limit", "value must be a positive integer");
  setLimit(n);
  ctx.fields.limit = n;
  return Response.json(gateStatus());
}

// POST: rescan the models dir and converge running children — load added
// models, drop removed ones — without a restart.
function handleAdminReload(req: Request, ctx: ReqCtx): Response {
  const denied = requireLocal(ctx);
  if (denied) return denied;
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  const r = reloadModels();
  ctx.fields.added = r.added.length;
  ctx.fields.removed = r.removed.length;
  return Response.json(r);
}

const LOCK_FILE = join(PATHS.home, "voiced.pid");

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    const raw = readFileSync(LOCK_FILE, "utf8").trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
      console.error(
        `voiced already running (PID ${pid}). reload with: launchctl kickstart -k gui/$UID/io.byteink.voiced`,
      );
      process.exit(1);
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    const raw = readFileSync(LOCK_FILE, "utf8").trim();
    if (Number(raw) === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown");
  for (const c of children.values()) {
    if (c.idle) clearTimeout(c.idle);
    try { c.proc.kill("SIGTERM"); } catch {}
  }
  releaseLock();
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function levelFor(status: number): "info" | "warn" | "error" {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

// Pure dispatch: every branch returns a Response so the access-log wrapper can
// time and record it uniformly. 499 (client cancel) is produced inside the
// handlers via clientClosed and flows through here untouched.
function route(req: Request, url: URL, ctx: ReqCtx): Promise<Response> | Response {
  if (url.pathname === "/health") return handleHealth();
  if (url.pathname === "/v1/models") return handleModels();
  if (url.pathname === "/v1/audio/transcriptions") return withGate(() => handleTranscribe(req, ctx));
  if (url.pathname === "/v1/audio/speech") return handleSpeechStub();
  if (url.pathname === "/admin/limit") return handleAdminLimit(req, ctx);
  if (url.pathname === "/admin/reload") return handleAdminReload(req, ctx);
  if (url.pathname === "/") return new Response("voiced\n");
  return jsonError(404, "not_found", `no route for ${url.pathname}`);
}

export async function runServer(): Promise<void> {
  if (!existsSync(PATHS.home)) mkdirSync(PATHS.home, { recursive: true });
  if (!existsSync(PATHS.logs)) mkdirSync(PATHS.logs, { recursive: true });
  if (!existsSync(PATHS.stt)) mkdirSync(PATHS.stt, { recursive: true });

  acquireLock();

  const found = discoverSttModels();
  if (found.length === 0) {
    releaseLock();
    console.error(`no STT models in ${PATHS.stt}. run: voiced add <name>`);
    process.exit(1);
  }

  found.forEach((m, i) => known.set(m.name, { name: m.name, path: m.path, port: BASE_PORT + i }));
  log("boot", { models: found.map((m) => m.name), idle_ms: IDLE_MS });

  try {
    Bun.serve({
      port: PORT,
      hostname: "0.0.0.0",
      idleTimeout: 120,
      async fetch(req: Request, server) {
        const ip = server.requestIP(req)?.address;
        const ctx: ReqCtx = { id: crypto.randomUUID().slice(0, 8), fields: {}, local: ip === "127.0.0.1" || ip === "::1" };
        const url = new URL(req.url);
        log("req.start", { id: ctx.id, method: req.method, path: url.pathname, ip });
        const started = Date.now();
        const res = await route(req, url, ctx);
        log("req.end", { id: ctx.id, status: res.status, ms: Date.now() - started, ...ctx.fields }, levelFor(res.status));
        return res;
      },
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/EADDRINUSE|address already in use/i.test(msg)) {
      console.error(`voiced port ${PORT} already in use. another instance is running.`);
    } else {
      console.error(`failed to bind :${PORT}: ${msg}`);
    }
    for (const c of children.values()) { try { c.proc.kill("SIGTERM"); } catch {} }
    releaseLock();
    process.exit(1);
  }

  log("listening", { port: PORT, models: [...known.keys()] });
}
