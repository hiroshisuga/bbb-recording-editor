import { externalVideos, presentationRanges } from './model';

// A matching server supplies the original foreground timeline. The fallback
// keeps older manifests readable and clearly identifies their legacy inference.
export function originalContentSegments(recording) {
  if (Array.isArray(recording.content_segments)) return recording.content_segments;
  const duration = recording.duration_ms, screens = recording.assets.filter(a => a.kind === 'deskshare');
  const videos = externalVideos(recording.events, duration), slides = presentationRanges(recording.events, duration);
  const points = [...new Set([0, duration, ...screens.flatMap(a => [a.start_ms, a.end_ms]), ...videos.flatMap(v => [v.timestamp * 1000, v.clear * 1000])])].sort((a, b) => a - b);
  return points.slice(0, -1).map((start_ms, index) => {
    const screen = screens.find(a => a.start_ms <= start_ms && a.end_ms > start_ms);
    const external = videos.some(v => v.timestamp * 1000 <= start_ms && v.clear * 1000 > start_ms);
    const source = external ? 'external' : screen ? 'screen' : recording.slides.length || slides.length ? 'slides' : 'none';
    return { start_ms, end_ms: points[index + 1], source, inferred: true, available: source !== 'screen' || (!!screen.has_video && !screen.error), editable: false };
  });
}

export function applyContentOverrides(segments, overrides = []) {
  return segments.flatMap(segment => {
    const relevant = overrides.filter(r => r.start_ms < segment.end_ms && r.end_ms > segment.start_ms);
    const points = [...new Set([segment.start_ms, segment.end_ms, ...relevant.flatMap(r => [Math.max(segment.start_ms, r.start_ms), Math.min(segment.end_ms, r.end_ms)])])].sort((a, b) => a - b);
    return points.slice(0, -1).map((start_ms, index) => {
      const override = relevant.find(r => r.start_ms <= start_ms && r.end_ms > start_ms);
      return { ...segment, start_ms, end_ms: points[index + 1], original_source: segment.source, edited: !!override,
        source: override?.source || segment.source, available: override ? !!segment[`${override.source}_available`] : segment.available };
    });
  });
}

export function replaceContentOverride(overrides, selection, source) {
  const { start_ms: start, end_ms: end } = selection;
  const remaining = overrides.flatMap(range => range.end_ms <= start || range.start_ms >= end ? [range] : [
    { ...range, end_ms: start }, { ...range, start_ms: end },
  ].filter(range => range.start_ms < range.end_ms));
  if (source !== 'original') remaining.push({ start_ms: start, end_ms: end, source });
  return remaining.sort((a, b) => a.start_ms - b.start_ms).reduce((all, range) => {
    const previous = all[all.length - 1];
    if (previous && previous.end_ms === range.start_ms && previous.source === range.source) previous.end_ms = range.end_ms;
    else all.push({ ...range });
    return all;
  }, []);
}

export function contentChoiceReason(recording, segments, selection, source) {
  if (!Number.isFinite(selection.start_ms) || !Number.isFinite(selection.end_ms) || selection.start_ms >= selection.end_ms || selection.start_ms < 0 || selection.end_ms > recording.duration_ms) return 'contentSelectRange';
  if (source === 'original') return '';
  if (!recording.content_edit_supported) return recording.content_edit_reason || 'contentUnsupported';
  const selected = segments.filter(s => s.start_ms < selection.end_ms && s.end_ms > selection.start_ms);
  if (!selected.length || selected.reduce((total, s) => total + Math.min(s.end_ms, selection.end_ms) - Math.max(s.start_ms, selection.start_ms), 0) !== selection.end_ms - selection.start_ms || selected.some(s => !s.editable)) return 'contentProtectedRange';
  return selected.every(s => s[`${source}_available`]) ? '' : 'contentMissingSource';
}

export function contentAt(segments, time) {
  let low = 0, high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1, segment = segments[mid];
    if (time < segment.start_ms) high = mid - 1;
    else if (time >= segment.end_ms) low = mid + 1;
    else return segment;
  }
  return time === segments[segments.length - 1]?.end_ms ? segments[segments.length - 1] : undefined;
}

export function displayContentSegments(segments) {
  return segments.reduce((all, segment) => {
    const previous = all[all.length - 1];
    if (previous && previous.end_ms === segment.start_ms && ['source', 'edited', 'original_source', 'inferred', 'available'].every(key => previous[key] === segment[key])) previous.end_ms = segment.end_ms;
    else all.push({ ...segment });
    return all;
  }, []);
}
