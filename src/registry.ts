// Curated catalogue of downloadable STT models. Keys are the short names users
// type into `voiced add <name>`; they become the model IDs served on /v1/models.

export type CatalogEntry = { name: string; url: string; size: string; desc: string };

export const STT_CATALOG: Record<string, CatalogEntry> = {
  "large-v3-turbo": {
    name: "large-v3-turbo",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    size: "1.6 GB",
    desc: "Fast multilingual. Default. ~1s per 10s clip on M-series.",
  },
  "large-v3": {
    name: "large-v3",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
    size: "2.9 GB",
    desc: "Max-accuracy multilingual. Slower.",
  },
  "large-v3-turbo-q5": {
    name: "large-v3-turbo-q5_0",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    size: "547 MB",
    desc: "Quantised turbo. Smallest large-class.",
  },
  "medium": {
    name: "medium",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    size: "1.5 GB",
    desc: "Older medium multilingual.",
  },
  "base.en": {
    name: "base.en",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    size: "142 MB",
    desc: "Tiny English-only.",
  },
};
