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
  // Quantized 5% steps avoid changing playbackRate on every audio-clock tick.
  // A five-second lag reaches the 2x ceiling; an ahead video slows to at least
  // half the requested rate. Never change the master audio to match the video.
  const adjustment = Math.min(drift > 0 ? 1 : 0.5, Math.ceil(Math.abs(drift) * 4) * 0.05);
  let result = rate * (1 + (drift > 0 ? adjustment : -adjustment));
  if (drift > 0) {
    // Keep at least two wall-clock seconds of buffered video at the catch-up
    // rate. Low buffers return to the user's base rate instead of draining faster.
    const bufferLimit = Math.floor(ahead / 2 * 20) / 20;
    result = Math.min(result, Math.max(rate, bufferLimit));
  }
  return Math.max(0.25, Math.min(4, result));
}
