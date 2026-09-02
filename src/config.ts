import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

// Single source of truth: bumped only by the release flow. Bun inlines this at
// compile time, so the binary reports its own build version.
export const VERSION: string = pkg.version;

const HOME_DIR = Bun.env.VOICED_HOME ?? join(homedir(), ".voiced");

export const PATHS = {
  home: HOME_DIR,
  stt: join(HOME_DIR, "models"),
  tts: join(HOME_DIR, "voices"),
  logs: join(HOME_DIR, "logs"),
};

export const PORT = Number(Bun.env.VOICED_PORT ?? 2022);
export const BASE_PORT = Number(Bun.env.VOICED_BASE_PORT ?? 2023);
export const WHISPER_BIN = Bun.env.VOICED_WHISPER_BIN ?? "/opt/homebrew/bin/whisper-server";
export const THREADS = Bun.env.VOICED_THREADS ?? "8";

// How long a loaded model may sit unused before its whisper-server is stopped.
// Models are spawned on first use, not at boot: whisper-server holds the whole
// model resident (large-v3 is 2.9 GB), so supervising every installed model for
// the life of the daemon costs that much RAM around the clock for a workload
// that is idle almost all of it. 0 disables eviction and keeps a child alive
// once started.
export const IDLE_MS = Number(Bun.env.VOICED_IDLE_MS ?? 5 * 60_000);

// How long to wait for a freshly spawned whisper-server to answer. A cold start
// reads the model off disk, so this is seconds, not milliseconds.
export const SPAWN_TIMEOUT_MS = Number(Bun.env.VOICED_SPAWN_TIMEOUT_MS ?? 120_000);

export const STT_ALIASES: Record<string, string> = {
  "whisper-1": "large-v3-turbo",
};
