// Browser-reported continuous time range, not a byte-accurate cache budget.
export function bufferedAhead(video, position = video.currentTime) {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= position && position <= ranges.end(i)) return Math.max(0, ranges.end(i) - position);
  }
  return 0;
}

export function synchronizationRate(rate, drift, ahead, measuredCeiling = null) {
  if (Math.abs(drift) <= 0.15) return rate;
  // Keep the conservative response for <=6 seconds at the user's base rate.
  // Between 6 and 18 seconds, progressively increase the gain and ceiling:
  // ample buffers can correct the last few seconds quickly instead of slowly
  // coasting toward alignment. Re-evaluate as buffered data is consumed/refilled.
  // Successful frame/clock observations can validate correction despite a short
  // buffered range (Chromium may report only its demuxed queue for cached VBR).
  const measured = Number.isFinite(measuredCeiling) && measuredCeiling >= rate;
  const headroom = measured ? 1 : Math.max(0, Math.min(1, (ahead / rate - 6) / 12));
  const gain = drift > 0 ? 0.2 + 0.6 * headroom : 0.2;
  const ceiling = drift > 0 ? Math.floor((1 + headroom) * 20) / 20 : 0.5;
  // Quantized 5% steps avoid changing playbackRate on every audio-clock tick.
  const adjustment = Math.min(ceiling, Math.ceil(Math.abs(drift) * gain * 20) * 0.05);
  let result = rate * (1 + (drift > 0 ? adjustment : -adjustment));
  if (drift > 0) {
    // Without measured progress, conservatively reserve two wall-clock seconds
    // of reported buffering. Otherwise use the successfully observed speed.
    const limit = measured ? measuredCeiling : Math.max(rate, Math.floor(ahead / 2 * 20) / 20);
    result = Math.min(result, limit);
  }
  return Math.max(0.25, Math.min(4, result));
}
