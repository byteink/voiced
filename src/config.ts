import { homedir } from "node:os";
import { join } from "node:path";

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

export const STT_ALIASES: Record<string, string> = {
  "whisper-1": "large-v3-turbo",
};
