// voiced-diarize: speaker-diarization sidecar.
//
// Runs NVIDIA Sortformer v2/v2.1 (streaming, 4-speaker max) over a 16 kHz mono
// wav and prints one line per speaker turn to stdout:
//
//     START -- END speaker_NN
//
// (seconds, two decimals). This is the exact line format the sherpa-onnx
// diarizer emits, so voiced's existing parser handles both engines unchanged.
// Everything that is not a turn line goes to stderr.

use std::env;
use std::process::ExitCode;

use parakeet_rs::sortformer::{DiarizationConfig, Sortformer};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        return Err(format!("usage: {} <model.onnx> <audio-16k-mono.wav>", args[0]).into());
    }
    let model_path = &args[1];
    let audio_path = &args[2];

    // Sortformer resamples internally; offsets in the result are 16 kHz samples
    // regardless of the input rate, so timestamps are always sample/16000.
    let mut reader = hound::WavReader::open(audio_path)?;
    let spec = reader.spec();
    let audio: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|s| s.map(|s| s as f32 / 32768.0))
            .collect::<Result<Vec<_>, _>>()?,
    };
    if audio.is_empty() {
        return Err("empty audio".into());
    }

    // callhome preset = NVIDIA's default tuning; chunk/fifo/cache come from the
    // ONNX metadata and match the training config for best accuracy.
    let mut sortformer = Sortformer::with_config(model_path, None, DiarizationConfig::callhome())?;
    eprintln!(
        "voiced-diarize: chunk_len={} fifo_len={} spkcache_len={} right_context={} latency={:.2}s",
        sortformer.chunk_len,
        sortformer.fifo_len,
        sortformer.spkcache_len,
        sortformer.right_context,
        sortformer.latency()
    );

    let segments = sortformer.diarize(audio, spec.sample_rate, spec.channels)?;
    for seg in &segments {
        let start = seg.start as f64 / 16_000.0;
        let end = seg.end as f64 / 16_000.0;
        println!("{:.2} -- {:.2} speaker_{:02}", start, end, seg.speaker_id);
    }
    eprintln!("voiced-diarize: {} turns", segments.len());
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("voiced-diarize: error: {e}");
            ExitCode::FAILURE
        }
    }
}
