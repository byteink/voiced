// Single owner of request admission control. Nothing else in the app counts
// in-flight work or decides when to shed load — every gated request funnels
// through withGate(). This is the one chokepoint on purpose.
//
// Reject-when-full (no internal queue): at capacity we return 503 immediately so
// callers get backpressure instead of an unbounded wait. The cap exists to stop
// the diarize path from fork-bombing the host (one ffmpeg + one ~492MB diarizer
// process per request) and to give the serialized whisper path a fast-fail
// ceiling instead of a silent pile-up.

function envInt(name: string, dflt: number): number {
  const n = Number(Bun.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

const LIMIT = envInt("VOICED_MAX_CONCURRENCY", 4);

let inFlight = 0;

function busy(): Response {
  return new Response(
    JSON.stringify({ error: { message: `server at capacity (${LIMIT} concurrent); retry shortly`, type: "overloaded_error", code: "busy" } }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } },
  );
}

// Read-only view for /health and diagnostics. Exposing state is not control —
// the counter is only ever mutated inside withGate.
export function gateStatus(): { inFlight: number; limit: number } {
  return { inFlight, limit: LIMIT };
}

// Admit and run `work`, or return 503 if already at capacity. The permit is
// always released — success, handler error, or client abort — via finally, so a
// permit can never leak.
export async function withGate(work: () => Promise<Response>): Promise<Response> {
  if (inFlight >= LIMIT) return busy();
  inFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
  }
}
