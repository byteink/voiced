# voiced

Local-only, OpenAI-compatible voice gateway for this Mac (M-series).
Currently ships **speech-to-text** backed by `whisper.cpp`; **text-to-speech**
is reserved in the API surface but not yet implemented. Purpose-built to
serve OpenClaw on a Raspberry Pi over Tailscale.

---

## Architecture

One binary, one plist. `voiced` is both the HTTP gateway and the supervisor
for native `whisper-server` children.

```
Telegram voice note
        │
        ▼
OpenClaw (Pi 5)
        │  OpenAI SDK → POST /v1/audio/transcriptions
        ▼
Tailscale: http://mustafa-macbook-pro:2022
        │
        ▼
voiced  (compiled Bun binary, :2022)
        │
        ├── spawns whisper-server :2023  ggml-large-v3-turbo.bin
        ├── spawns whisper-server :2024  ggml-large-v3.bin
        └── …one child per ggml-*.bin in ~/.voiced/models/
```

On boot, voiced scans `~/.voiced/models/` for `ggml-*.bin` files, spawns
one `whisper-server` child per model on ascending ports starting at 2023,
and routes `POST /v1/audio/transcriptions` to the matching child by the
`model` field. Crashed children respawn on a 2-second backoff.

Why the gateway exists:

- Homebrew `whisper-server` only exposes `/inference`, not OpenAI's
  `/v1/audio/transcriptions`. Clients like OpenClaw speak OpenAI.
- `whisper-server` is single-model per process; serving multiple models
  means multiple processes, which needs supervision.
- Metal + ANE acceleration requires native macOS execution — no Docker.

---

## Layout

```
voiced/
├── src/
│   ├── main.ts           CLI dispatcher
│   ├── server.ts         HTTP gateway + supervisor
│   ├── cli.ts            ls / add / rm / doctor
│   ├── registry.ts       curated STT model catalogue
│   └── config.ts         paths + env vars
├── package.json
├── tsconfig.json
├── dist/voiced           compiled binary (gitignored)
├── launchd/
│   └── com.user.voiced.plist
└── scripts/
    ├── install.sh
    └── uninstall.sh
```

Runtime state (outside the repo):

```
~/.voiced/
├── models/              STT — ggml-*.bin files
├── voices/              TTS — reserved, not used yet
└── logs/
    ├── voiced.out.log
    └── voiced.err.log
```

---

## Requirements

- macOS on Apple Silicon.
- `brew install whisper-cpp ffmpeg`
- `bun` to build. Compiled binary has no runtime dep.
- Tailscale, this Mac reachable as `mustafa-macbook-pro`.

---

## Install

```bash
bash scripts/install.sh
```

Builds the binary if missing, creates `~/.voiced/{logs,models,voices}`,
installs the launchd agent, starts it.

On first install `voiced` exits immediately with `no STT models in
~/.voiced/models`. Add a model:

```bash
dist/voiced add large-v3-turbo
launchctl kickstart -k gui/$UID/com.user.voiced
```

---

## CLI

```bash
voiced              # start HTTP server (what launchd runs)
voiced ls           # installed + available models
voiced add <name>   # download from catalogue
voiced rm  <name>   # delete installed model
voiced doctor       # system health check
voiced help
```

The CLI operates on the same data dir as the server, so `ls` and `add`
work from anywhere once the binary is on PATH.

### `voiced ls`

```
STT models (installed):
  large-v3                  2.9 GB
  large-v3-turbo            1.6 GB

STT catalogue (available via `voiced add <name>`):
  ✓ large-v3-turbo        1.6 GB   Fast multilingual. Default.
  ✓ large-v3              2.9 GB   Max-accuracy multilingual.
    large-v3-turbo-q5     547 MB   Quantised turbo.
    medium                1.5 GB   Older multilingual.
    base.en               142 MB   Tiny English-only.
```

### `voiced doctor`

Checks data dirs, `whisper-server` binary, `ffmpeg`, models present, plist
installed, HTTP endpoint responsive. Exits non-zero on any failure.

---

## API surface

### `POST /v1/audio/transcriptions`

OpenAI-compatible. Multipart form: `file`, `model`, `language`, `prompt`,
`temperature`, `response_format` (`json`/`text`/`srt`/`verbose_json`/`vtt`).
Unknown fields are dropped.

### `GET /v1/models`

OpenAI-shaped list of loaded model IDs. `whisper-1` is aliased to
`large-v3-turbo` when that model is installed.

### `POST /v1/audio/speech`

**Not yet implemented.** Returns HTTP 501 with
`{"error":{"code":"not_implemented"}}`. Route reserved so clients that
hardcode the path don't get generic 404s.

### `GET /health`

```json
{ "ok": true, "upstreams": { "large-v3-turbo": true, "large-v3": true } }
```

503 if any child is down or no models loaded.

---

## Configuration

Env vars (set in the plist):

| Variable | Default | Purpose |
|---|---|---|
| `VOICED_PORT` | `2022` | HTTP listen port |
| `VOICED_HOME` | `~/.voiced` | Data root |
| `VOICED_BASE_PORT` | `2023` | First port for children |
| `VOICED_WHISPER_BIN` | `/opt/homebrew/bin/whisper-server` | Child binary |
| `VOICED_THREADS` | `8` | Threads per child |

Edit `launchd/com.user.voiced.plist` then re-run `scripts/install.sh`.

---

## Client config (OpenClaw on Pi)

```
OPENAI_BASE_URL=http://mustafa-macbook-pro:2022/v1
OPENAI_API_KEY=any-non-empty-string
OPENAI_AUDIO_MODEL=whisper-1
```

---

## Operations

```bash
launchctl list | grep voiced                          # status
tail -f ~/.voiced/logs/voiced.err.log                 # logs
launchctl kickstart -k gui/$UID/com.user.voiced       # reload
kill -9 $(pgrep -f dist/voiced); sleep 12; curl .../health   # restart test
```

### Rebuild after code change

```bash
bun run build
launchctl kickstart -k gui/$UID/com.user.voiced
```

---

## Known constraints

- Mac must be awake. launchd keeps the process alive, macOS sleep does not.
- Memory scales with loaded model count (turbo ~2 GB, large-v3 ~3.5 GB each).
- No auth — Tailscale is the trust boundary.
- No streaming. Whole file in, whole transcript out.
- TTS not implemented.

---

## Uninstall

```bash
bash scripts/uninstall.sh
```

Leaves `~/.voiced/` intact. Remove it manually if you also want the
models gone.
