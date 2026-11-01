import { normalizeRanges, retainChimeGaps } from './model';

// Mirror CutChime.cues/effective: cue audio occupies the two sides of an
// omitted gap (125ms each), or the entire gap when it is at most 250ms.
export function recordingClock(recordRanges, chimeGaps, duration) {
  const records = normalizeRanges(recordRanges, duration);
  const cues = retainChimeGaps(records, chimeGaps, duration).flatMap(gap => gap.end_ms - gap.start_ms <= 250
    ? [gap] : [{ start_ms: gap.start_ms, end_ms: gap.start_ms + 125 },
      { start_ms: gap.end_ms - 125, end_ms: gap.end_ms }]);
  let total = 0;
  const ranges = normalizeRanges([...records, ...cues], duration).map(range => {
    const result = { ...range, offset: total };
    total += range.end_ms - range.start_ms;
    return result;
  });
  return {
    ranges, total,
    at(value) {
      const time = Math.max(0, Math.min(duration, value));
      let low = 0, high = ranges.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (ranges[middle].start_ms <= time) low = middle + 1;
        else high = middle;
      }
      const index = low - 1, range = ranges[index];
      if (!range) return { time: 0, included: false, empty: !ranges.length };
      return { time: range.offset + Math.min(time, range.end_ms) - range.start_ms,
        included: time < range.end_ms || (index === ranges.length - 1 && time === range.end_ms), empty: false };
    },
  };
}
