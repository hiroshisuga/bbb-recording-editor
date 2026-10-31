// Only the continuous range containing this position can feed playback.
export function bufferedAhead(video, position = video.currentTime) {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= position && position <= ranges.end(i)) return Math.max(0, ranges.end(i) - position);
  }
  return 0;
}

export function synchronizationRate(rate, drift, ahead) {
  if (Math.abs(drift) <= 0.15) return rate;
  // Keep the conservative response for <=6 seconds at the user's base rate.
  // Between 6 and 18 seconds, progressively increase the gain and ceiling:
  // ample buffers can correct the last few seconds quickly instead of slowly
  // coasting toward alignment. Re-evaluate as buffered data is consumed/refilled.
  const headroom = Math.max(0, Math.min(1, (ahead / rate - 6) / 12));
  const gain = drift > 0 ? 0.2 + 0.6 * headroom : 0.2;
  const ceiling = drift > 0 ? Math.floor((1 + headroom) * 20) / 20 : 0.5;
  // Quantized 5% steps avoid changing playbackRate on every audio-clock tick.
  const adjustment = Math.min(ceiling, Math.ceil(Math.abs(drift) * gain * 20) * 0.05);
  let result = rate * (1 + (drift > 0 ? adjustment : -adjustment));
  if (drift > 0) {
    // Keep at least two wall-clock seconds of buffered video at the catch-up
    // rate. Low buffers return to the user's base rate instead of draining faster.
    const bufferLimit = Math.floor(ahead / 2 * 20) / 20;
    result = Math.min(result, Math.max(rate, bufferLimit));
  }
  return Math.max(0.25, Math.min(4, result));
}
