// Opt-in speaker diarization via a native sherpa-onnx sidecar (ONNX Runtime,
// no Python). Full-file only. The binary + ONNX models are downloaded into
// ~/.voiced/diarize on `voiced diarize install`, mirroring how STT models are
// fetched. The diarizer labels speaker turns by time; the server overlaps those
// turns with whisper segments to tag each segment with a speaker.

import { spawn } from "bun";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.ts";

const SHERPA_VERSION = "1.13.2";
const REL = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

// Prebuilt osx-arm64 runtime (no TTS), pyannote segmentation, and a wespeaker
// embedding model. The embedding filename contains "++" — percent-encoded here.
const ASSETS = {
  runtime: `${REL}/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-osx-arm64-shared-no-tts.tar.bz2`,
  segmentation: `${REL}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
  embedding: `${REL}/speaker-recongition-models/wespeaker_en_voxceleb_CAM%2B%2B.onnx`,
};

const DIR = join(PATHS.home, "diarize");
const P = {
  dir: DIR,
  bin: join(DIR, "sherpa", "bin", "sherpa-onnx-offline-speaker-diarization"),
  lib: join(DIR, "sherpa", "lib"),
  models: join(DIR, "models"),
  segmentation: join(DIR, "models", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
  embedding: join(DIR, "models", "wespeaker_en_voxceleb_CAM++.onnx"),
};

// Clustering similarity threshold used when the speaker count is unknown.
// Lower = more speakers. 0.5 validated correct on the reference English clips.
const THRESHOLD = Number(Bun.env.VOICED_DIARIZE_THRESHOLD ?? 0.5);

export type SpeakerRange = { start: number; end: number; speaker: string };

export function diarizeInstalled(): boolean {
  return existsSync(P.bin) && existsSync(P.segmentation) && existsSync(P.embedding);
}

export function diarizeDir(): string {
  return P.dir;
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

export async function installDiarize(): Promise<void> {
  if (diarizeInstalled()) {
    console.log(`already installed: ${P.dir}`);
    return;
  }
  mkdirSync(join(P.dir, "sherpa"), { recursive: true });
  mkdirSync(P.models, { recursive: true });

  console.log("downloading sherpa-onnx runtime (~23 MB)…");
  const rt = "/tmp/voiced-sherpa-runtime.tar.bz2";
  await download(ASSETS.runtime, rt);
  await run(["tar", "xjf", rt, "-C", join(P.dir, "sherpa"), "--strip-components=1"]);
  unlinkSync(rt);

  console.log("downloading segmentation model (~6 MB)…");
  const seg = "/tmp/voiced-seg.tar.bz2";
  await download(ASSETS.segmentation, seg);
  await run(["tar", "xjf", seg, "-C", P.models]);
  unlinkSync(seg);

  console.log("downloading speaker-embedding model (~28 MB)…");
  await download(ASSETS.embedding, P.embedding);

  // Unsigned arm64 binaries are killed on launch; ad-hoc sign the binary and
  // every dylib it loads via @loader_path/../lib.
  console.log("signing native binaries…");
  for (const f of readdirSync(P.lib)) {
    if (f.endsWith(".dylib")) await run(["codesign", "-s", "-", "--force", join(P.lib, f)]);
  }
  await run(["codesign", "-s", "-", "--force", P.bin]);

  console.log(`installed diarization support → ${P.dir}`);
}

const LINE = /^(\d+(?:\.\d+)?)\s+--\s+(\d+(?:\.\d+)?)\s+(speaker_\d+)\s*$/;

// The binary assigns arbitrary, non-contiguous cluster ids (speaker_00,
// speaker_03, …). Remap to contiguous SPEAKER_00.. by first appearance so the
// labels match the whisperX / Together convention clients expect.
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
    out.push({ start: parseFloat(m[1]), end: parseFloat(m[2]), speaker });
  }
  return out;
}

export async function runDiarization(
  wavPath: string,
  opts: { numSpeakers?: number } = {},
): Promise<SpeakerRange[]> {
  const cmd = [
    P.bin,
    `--segmentation.pyannote-model=${P.segmentation}`,
    `--embedding.model=${P.embedding}`,
  ];
  if (opts.numSpeakers && opts.numSpeakers > 0) {
    cmd.push(`--clustering.num-clusters=${opts.numSpeakers}`);
  } else {
    cmd.push(`--clustering.cluster-threshold=${THRESHOLD}`);
  }
  cmd.push(wavPath);

  const p = spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) {
    const err = (await new Response(p.stderr).text()).trim().split("\n").slice(-3).join(" ");
    throw new Error(`diarizer failed (${p.exitCode}): ${err}`);
  }
  return parseDiarization(await new Response(p.stdout).text());
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
