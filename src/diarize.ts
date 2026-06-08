// Opt-in speaker diarization. Two native, Python-free engines, selectable per
// install:
//
//   sherpa     — sherpa-onnx clustering (pyannote segmentation + wespeaker
//                embedding). Any number of speakers. The original engine.
//   sortformer — NVIDIA Sortformer v2/v2.1 (streaming) via the bundled
//                `voiced-diarize` Rust sidecar (ONNX Runtime, CPU). Far better
//                turn detection, but a hard 4-speaker maximum.
//
// Models live under ~/.voiced/diarize; the active one is recorded in
// ~/.voiced/diarize/active. Both engines emit the same `START -- END speaker_NN`
// lines, so the parser and the server's segment-tagging are engine-agnostic. The
// server overlaps the turns with whisper segments to tag each with a speaker.

import { spawn } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "./config.ts";

const SHERPA_VERSION = "1.13.2";
const REL = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const HF = "https://huggingface.co/altunenes/parakeet-rs/resolve/main";

// Prebuilt osx-arm64 sherpa runtime (no TTS), pyannote segmentation, and a
// wespeaker embedding model. The embedding filename contains "++" — percent-
// encoded here.
const ASSETS = {
  runtime: `${REL}/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-osx-arm64-shared-no-tts.tar.bz2`,
  segmentation: `${REL}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
  embedding: `${REL}/speaker-recongition-models/wespeaker_en_voxceleb_CAM%2B%2B.onnx`,
};

const DIR = join(PATHS.home, "diarize");
const MODELS = join(DIR, "models");
const ACTIVE_FILE = join(DIR, "active");

const SHERPA = {
  bin: join(DIR, "sherpa", "bin", "sherpa-onnx-offline-speaker-diarization"),
  lib: join(DIR, "sherpa", "lib"),
  segmentation: join(MODELS, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
  embedding: join(MODELS, "wespeaker_en_voxceleb_CAM++.onnx"),
};

// Sortformer ONNX models hosted by the parakeet-rs author. All fp32 (~492 MB);
// no trustworthy quantised build exists, so we ship full precision only.
const SORTFORMER: Record<string, { file: string; url: string; bytes: number }> = {
  "sortformer-v2.1": { file: "sortformer-v2.1.onnx", url: `${HF}/diar_streaming_sortformer_4spk-v2.1.onnx`, bytes: 492243003 },
  "sortformer-v2": { file: "sortformer-v2.onnx", url: `${HF}/diar_streaming_sortformer_4spk-v2.onnx`, bytes: 492243002 },
};

export type Engine = "sherpa" | "sortformer";
export type DiarizeModel = { key: string; engine: Engine; size: string; maxSpeakers: number | null; desc: string };

// Listed best-first; `sortformer-v2.1` is the recommended default to `use`.
export const DIARIZE_CATALOG: DiarizeModel[] = [
  { key: "sortformer-v2.1", engine: "sortformer", size: "492 MB", maxSpeakers: 4, desc: "NVIDIA Sortformer v2.1 (streaming). Best accuracy. Up to 4 speakers." },
  { key: "sortformer-v2", engine: "sortformer", size: "492 MB", maxSpeakers: 4, desc: "NVIDIA Sortformer v2 (streaming). Up to 4 speakers." },
  { key: "sherpa", engine: "sherpa", size: "57 MB", maxSpeakers: null, desc: "pyannote + wespeaker clustering. Any number of speakers." },
];

// Clustering similarity threshold used by the sherpa engine when the speaker
// count is unknown. Lower = more speakers. 0.5 validated on the reference clips.
const THRESHOLD = Number(Bun.env.VOICED_DIARIZE_THRESHOLD ?? 0.5);

export type SpeakerRange = { start: number; end: number; speaker: string };

export function diarizeDir(): string {
  return DIR;
}

// The `voiced-diarize` sidecar ships beside the `voiced` binary (Homebrew). In
// dev, fall back to the cargo build output or PATH. Env override wins.
export function sortformerBin(): string | null {
  const candidates: string[] = [];
  if (Bun.env.VOICED_DIARIZE_BIN) candidates.push(Bun.env.VOICED_DIARIZE_BIN);
  try { candidates.push(join(dirname(realpathSync(process.execPath)), "voiced-diarize")); } catch {}
  candidates.push(join(import.meta.dir, "..", "sidecar", "target", "release", "voiced-diarize"));
  for (const c of candidates) { if (existsSync(c)) return c; }
  return Bun.which("voiced-diarize");
}

function sherpaInstalled(): boolean {
  return existsSync(SHERPA.bin) && existsSync(SHERPA.segmentation) && existsSync(SHERPA.embedding);
}

export function modelInstalled(key: string): boolean {
  if (key === "sherpa") return sherpaInstalled();
  const m = SORTFORMER[key];
  return m !== undefined && existsSync(join(MODELS, m.file)) && sortformerBin() !== null;
}

function readActive(): string | null {
  try { return readFileSync(ACTIVE_FILE, "utf8").trim() || null; } catch { return null; }
}

// The model a request will actually use: the explicit selection if it is still
// installed, else the first installed catalogue entry (best-first), else none.
export function activeModel(): string | null {
  const a = readActive();
  if (a && modelInstalled(a)) return a;
  for (const m of DIARIZE_CATALOG) if (modelInstalled(m.key)) return m.key;
  return null;
}

// True when at least one diarization model is usable. Gates the server's
// diarize=true path (export name kept for the server's import).
export function diarizeInstalled(): boolean {
  return activeModel() !== null;
}

export function diarizeStatus(): { key: string; engine: Engine; installed: boolean; active: boolean }[] {
  const active = activeModel();
  return DIARIZE_CATALOG.map((m) => ({
    key: m.key, engine: m.engine, installed: modelInstalled(m.key), active: m.key === active,
  }));
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  const tmp = `${dest}.partial`;
  const writer = Bun.file(tmp).writer();
  const reader = res.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    bytes += value.byteLength;
    process.stdout.write(`\r  ${(bytes / 1e6).toFixed(1)} MB`);
  }
  await writer.end();
  await Bun.write(dest, Bun.file(tmp));
  unlinkSync(tmp);
  process.stdout.write("\n");
}

async function run(cmd: string[]): Promise<void> {
  const p = spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) {
    const err = (await new Response(p.stderr).text()).trim();
    throw new Error(`${cmd[0]} failed (${p.exitCode}): ${err}`);
  }
}

async function installSherpa(): Promise<void> {
  if (sherpaInstalled()) { console.log("sherpa already installed"); return; }
  mkdirSync(join(DIR, "sherpa"), { recursive: true });
  mkdirSync(MODELS, { recursive: true });

  console.log("downloading sherpa-onnx runtime (~23 MB)…");
  const rt = join(DIR, "runtime.tar.bz2");
  await download(ASSETS.runtime, rt);
  await run(["tar", "xjf", rt, "-C", join(DIR, "sherpa"), "--strip-components=1"]);
  unlinkSync(rt);

  console.log("downloading segmentation model (~6 MB)…");
  const seg = join(DIR, "seg.tar.bz2");
  await download(ASSETS.segmentation, seg);
  await run(["tar", "xjf", seg, "-C", MODELS]);
  unlinkSync(seg);

  console.log("downloading speaker-embedding model (~28 MB)…");
  await download(ASSETS.embedding, SHERPA.embedding);

  // Unsigned arm64 binaries are killed on launch; ad-hoc sign the binary and
  // every dylib it loads via @loader_path/../lib.
  console.log("signing native binaries…");
  for (const f of readdirSync(SHERPA.lib)) {
    if (f.endsWith(".dylib")) await run(["codesign", "-s", "-", "--force", join(SHERPA.lib, f)]);
  }
  await run(["codesign", "-s", "-", "--force", SHERPA.bin]);
}

async function installSortformer(key: string): Promise<void> {
  const m = SORTFORMER[key];
  if (sortformerBin() === null) {
    throw new Error("the voiced-diarize sidecar is missing — update voiced (brew upgrade voiced) and retry");
  }
  mkdirSync(MODELS, { recursive: true });
  const dest = join(MODELS, m.file);
  if (existsSync(dest)) { console.log(`${key} already installed`); return; }
  console.log(`downloading ${key} (${(m.bytes / 1e6).toFixed(0)} MB)…`);
  await download(m.url, dest);
}

// Install a catalogue model. Auto-select it only for a first-time user with no
// usable model yet; an existing user must `use` to switch, so adding a second
// engine never silently changes which one runs.
export async function addDiarizeModel(key: string): Promise<void> {
  const info = DIARIZE_CATALOG.find((m) => m.key === key);
  if (!info) throw new Error(`unknown diarization model '${key}'. run: voiced diarize ls`);
  const hadActive = activeModel() !== null;
  if (info.engine === "sherpa") await installSherpa();
  else await installSortformer(key);
  if (!hadActive) writeActive(key);
}

function writeActive(key: string): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(ACTIVE_FILE, `${key}\n`);
}

export function useDiarizeModel(key: string): void {
  if (!DIARIZE_CATALOG.some((m) => m.key === key)) throw new Error(`unknown diarization model '${key}'. run: voiced diarize ls`);
  if (!modelInstalled(key)) throw new Error(`not installed: ${key} — run: voiced diarize add ${key}`);
  writeActive(key);
}

export function removeDiarizeModel(key: string): void {
  if (!modelInstalled(key)) throw new Error(`not installed: ${key}`);
  if (key === "sherpa") {
    rmSync(join(DIR, "sherpa"), { recursive: true, force: true });
    rmSync(join(MODELS, "sherpa-onnx-pyannote-segmentation-3-0"), { recursive: true, force: true });
    rmSync(SHERPA.embedding, { force: true });
  } else {
    rmSync(join(MODELS, SORTFORMER[key].file), { force: true });
  }
  if (readActive() === key) { try { unlinkSync(ACTIVE_FILE); } catch {} }
}

// Legacy entry point: `voiced diarize install` sets up the sherpa engine, which
// is what earlier versions shipped. Kept so existing muscle memory still works.
export async function installDiarize(): Promise<void> {
  await addDiarizeModel("sherpa");
}

const LINE = /^(\d+(?:\.\d+)?)\s+--\s+(\d+(?:\.\d+)?)\s+(speaker_\d+)\s*$/;

// Engines assign arbitrary, non-contiguous ids (speaker_00, speaker_03, …).
// Remap to contiguous SPEAKER_00.. by first appearance so labels match the
// whisperX / Together convention clients expect.
export function parseDiarization(stdout: string): SpeakerRange[] {
  const remap = new Map<string, string>();
  const out: SpeakerRange[] = [];
  for (const raw of stdout.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    let speaker = remap.get(m[3]);
    if (!speaker) {
      speaker = `SPEAKER_${String(remap.size).padStart(2, "0")}`;
      remap.set(m[3], speaker);
    }
    out.push({ start: Number.parseFloat(m[1]), end: Number.parseFloat(m[2]), speaker });
  }
  return out;
}

async function spawnParse(cmd: string[], engine: string): Promise<SpeakerRange[]> {
  const p = spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) {
    const err = (await new Response(p.stderr).text()).trim().split("\n").slice(-3).join(" ");
    throw new Error(`${engine} diarizer failed (${p.exitCode}): ${err}`);
  }
  return parseDiarization(await new Response(p.stdout).text());
}

function runSherpa(wavPath: string, numSpeakers?: number): Promise<SpeakerRange[]> {
  const cmd = [
    SHERPA.bin,
    `--segmentation.pyannote-model=${SHERPA.segmentation}`,
    `--embedding.model=${SHERPA.embedding}`,
  ];
  if (numSpeakers && numSpeakers > 0) cmd.push(`--clustering.num-clusters=${numSpeakers}`);
  else cmd.push(`--clustering.cluster-threshold=${THRESHOLD}`);
  cmd.push(wavPath);
  return spawnParse(cmd, "sherpa");
}

function runSortformer(wavPath: string, key: string): Promise<SpeakerRange[]> {
  const bin = sortformerBin();
  if (!bin) throw new Error("voiced-diarize sidecar not found");
  return spawnParse([bin, join(MODELS, SORTFORMER[key].file), wavPath], "sortformer");
}

// Dispatch to the active engine. Sortformer caps at 4 speakers, so a request
// that explicitly needs more falls back to sherpa when it is installed.
export async function runDiarization(
  wavPath: string,
  opts: { numSpeakers?: number } = {},
): Promise<SpeakerRange[]> {
  const active = activeModel();
  if (!active) throw new Error("no diarization model installed — run: voiced diarize add <name>");
  const info = DIARIZE_CATALOG.find((m) => m.key === active)!;
  if (info.engine === "sortformer" && opts.numSpeakers && opts.numSpeakers > 4 && sherpaInstalled()) {
    return runSherpa(wavPath, opts.numSpeakers);
  }
  return info.engine === "sortformer" ? runSortformer(wavPath, active) : runSherpa(wavPath, opts.numSpeakers);
}

// Assign a speaker to a transcript segment by maximum temporal overlap, falling
// back to the nearest turn when a segment lands in a diarization gap.
export function speakerForSegment(start: number, end: number, ranges: SpeakerRange[]): string | null {
  if (ranges.length === 0) return null;
  let best: string | null = null;
  let bestOverlap = 0;
  for (const r of ranges) {
    const overlap = Math.min(end, r.end) - Math.max(start, r.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = r.speaker;
    }
  }
  if (best) return best;

  let nearest: string | null = null;
  let nearestGap = Infinity;
  for (const r of ranges) {
    const gap = r.start > end ? r.start - end : start - r.end;
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = r.speaker;
    }
  }
  return nearest;
}
