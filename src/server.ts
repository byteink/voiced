// voiced HTTP server + supervisor for native STT children.

import { spawn, type Subprocess } from "bun";
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS, PORT, BASE_PORT, WHISPER_BIN, THREADS, STT_ALIASES } from "./config.ts";

type Child = { name: string; port: number; path: string; proc: Subprocess };

const children = new Map<string, Child>();
let shuttingDown = false;

function now() {
  return new Date().toISOString();
}

function log(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: now(), event, ...extra }));
}

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
    if (!shuttingDown) setTimeout(() => supervise(name, modelPath, port), 2000);
  });
}

function resolveModel(requested: string | null): Child | null {
  if (!requested) return children.values().next().value ?? null;
  const name = STT_ALIASES[requested] ?? requested;
  return children.get(name) ?? null;
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

async function handleTranscribe(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  const inForm = await req.formData();
  const file = inForm.get("file");
  if (!(file instanceof Blob)) return jsonError(400, "missing_file", "file is required");

  const requested = inForm.get("model");
  const child = resolveModel(typeof requested === "string" ? requested : null);
  if (!child) {
    return jsonError(404, "model_not_found",
      `model '${String(requested)}' not loaded. available: ${[...children.keys()].join(", ")}`);
  }

  const out = new FormData();
  out.append("file", file, (file as File).name ?? "audio");
  for (const key of ["language", "prompt", "temperature", "response_format"] as const) {
    const v = inForm.get(key);
    if (typeof v === "string" && v.length > 0) out.append(key, v);
  }
  if (!inForm.has("response_format")) out.append("response_format", "json");

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${child.port}/inference`, { method: "POST", body: out });
  } catch (err) {
    return jsonError(502, "upstream_unreachable",
      `whisper-server for '${child.name}' not reachable: ${(err as Error).message}`);
  }

  const ms = Date.now() - started;
  const body = await upstream.arrayBuffer();
  log("transcribe", { model: child.name, status: upstream.status, ms, bytes: body.byteLength });
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
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
  return new Response(JSON.stringify({ ok, upstreams }), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

function handleSpeechStub(): Response {
  return jsonError(501, "not_implemented", "TTS (/v1/audio/speech) not yet available");
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown");
  for (const c of children.values()) { try { c.proc.kill("SIGTERM"); } catch {} }
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export async function runServer(): Promise<void> {
  if (!existsSync(PATHS.logs)) mkdirSync(PATHS.logs, { recursive: true });
  if (!existsSync(PATHS.stt)) mkdirSync(PATHS.stt, { recursive: true });

  const found = discoverSttModels();
  if (found.length === 0) {
    console.error(`no STT models in ${PATHS.stt}. run: voiced add <name>`);
    process.exit(1);
  }

  log("boot", { models: found.map((m) => m.name) });
  found.forEach((m, i) => supervise(m.name, m.path, BASE_PORT + i));
  await Promise.all([...children.values()].map((c) => waitReady(c.port, 60_000)));

  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    idleTimeout: 120,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return handleHealth();
      if (url.pathname === "/v1/models") return handleModels();
      if (url.pathname === "/v1/audio/transcriptions") return handleTranscribe(req);
      if (url.pathname === "/v1/audio/speech") return handleSpeechStub();
      if (url.pathname === "/") return new Response("voiced\n");
      return jsonError(404, "not_found", `no route for ${url.pathname}`);
    },
  });

  log("listening", { port: PORT, models: [...children.keys()] });
}
