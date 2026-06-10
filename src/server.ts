// voiced HTTP server + supervisor for native STT children.

import { spawn, type Subprocess } from "bun";
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PATHS, PORT, BASE_PORT, WHISPER_BIN, THREADS, STT_ALIASES } from "./config.ts";
import { diarizeInstalled, runDiarization, speakerForSegment } from "./diarize.ts";
import { log } from "./logger.ts";
import { withGate, gateStatus, setLimit } from "./gate.ts";

type Child = { name: string; port: number; path: string; proc: Subprocess };

// Per-request log context: a short id shared by the request's req.start/req.end
// lines, plus fields the handler enriches (model, bytes, cancellation, …).
// `local` is true when the connection came from loopback — it gates /admin/*.
type ReqCtx = { id: string; fields: Record<string, unknown>; local: boolean };

const children = new Map<string, Child>();
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

function supervise(name: string, modelPath: string, port: number) {
  const proc = spawnChild(modelPath, port);
  children.set(name, { name, port, path: modelPath, proc });
  proc.exited.then((code: number | null) => {
    log("child-exit", { name, code });
    // Respawn only a genuine crash: if the child was intentionally removed (or
    // replaced) its map entry is gone or holds a different proc, so we stop.
    if (!shuttingDown && children.get(name)?.proc === proc) {
      setTimeout(() => supervise(name, modelPath, port), 2000);
    }
  });
}

function resolveModel(requested: string | null): Child | null {
  if (!requested) return children.values().next().value ?? null;
  const name = STT_ALIASES[requested] ?? requested;
  return children.get(name) ?? null;
}

// Lowest port at/above BASE_PORT not already taken by a child. Bounded by the
// number of children.
function nextFreePort(): number {
  const used = new Set([...children.values()].map((c) => c.port));
  let p = BASE_PORT;
  while (used.has(p)) p++;
  return p;
}

// Converge the running children to the models on disk: supervise any newly
// added model, stop any whose file is gone. New children load in the
// background (/health reflects readiness). The sole mutator of child lifecycle
// outside boot/shutdown — `voiced add`/`rm` reach it via POST /admin/reload, so
// models change without a restart.
function reloadModels(): { added: string[]; removed: string[]; models: string[] } {
  const found = discoverSttModels();
  const names = new Set(found.map((m) => m.name));
  const added: string[] = [];
  const removed: string[] = [];
  for (const m of found) {
    if (children.has(m.name)) continue;
    supervise(m.name, m.path, nextFreePort());
    added.push(m.name);
  }
  // Snapshot before mutating: deleting from the live map mid-iteration skips
  // entries.
  const gone = [...children.keys()].filter((name) => !names.has(name));
  for (const name of gone) {
    const c = children.get(name)!;
    children.delete(name);              // delete first: the respawn guard then stops
    try { c.proc.kill("SIGTERM"); } catch {}
    removed.push(name);
  }
  if (added.length || removed.length) log("reload", { added, removed });
  return { added, removed, models: [...children.keys()] };
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
  const data = [...children.keys()].map((id) => ({
    id, object: "model", created: 0, owned_by: "voiced",
  }));
  for (const alias of Object.keys(STT_ALIASES)) {
    if (children.has(STT_ALIASES[alias])) {
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
  const child = resolveModel(typeof requested === "string" ? requested : null);
  if (!child) {
    return jsonError(404, "model_not_found",
      `model '${String(requested)}' not loaded. available: ${[...children.keys()].join(", ")}`);
  }

  if (isTruthy(inForm.get("diarize"))) return transcribeWithDiarization(inForm, file, child, signal, ctx);
  return proxyTranscribe(inForm, file, child, signal, ctx);
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

  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${child.port}/inference`, { method: "POST", body: out, signal });
  } catch (err) {
    if (isAbort(err)) return clientClosed(ctx, "upstream-fetch");
    return jsonError(502, "upstream_unreachable",
      `whisper-server for '${child.name}' not reachable: ${(err as Error).message}`);
  }

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

  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${child.port}/inference`, { method: "POST", body: out, signal });
  } catch (err) {
    if (isAbort(err)) throw err; // unwound centrally by transcribeWithDiarization
    return { ok: false, res: jsonError(502, "upstream_unreachable",
      `whisper-server for '${child.name}' not reachable: ${(err as Error).message}`) };
  }
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
  const ok = Object.values(upstreams).every(Boolean) && children.size > 0;
  return new Response(JSON.stringify({ ok, upstreams, ...gateStatus() }), {
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
  for (const c of children.values()) { try { c.proc.kill("SIGTERM"); } catch {} }
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

  log("boot", { models: found.map((m) => m.name) });
  found.forEach((m, i) => supervise(m.name, m.path, BASE_PORT + i));
  await Promise.all([...children.values()].map((c) => waitReady(c.port, 60_000)));

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

  log("listening", { port: PORT, models: [...children.keys()] });
}
