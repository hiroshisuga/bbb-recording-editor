import { applyContentOverrides, contentAt, contentChoiceReason, displayContentSegments, originalContentSegments, replaceContentOverride } from './contentModel';
const segment = (start_ms, end_ms, source, extra = {}) => ({ start_ms, end_ms, source, available: true, inferred: false, editable: true, screen_available: true, slides_available: true, ...extra });
const original = [segment(0, 2000, 'screen'), segment(2000, 4000, 'slides'), segment(4000, 6000, 'screen')];
const recording = { duration_ms: 6000, content_edit_supported: true };

test('an override wins within its half-open interval, preserving the original source and boundary switches', () => {
  const result = applyContentOverrides(original, [{ start_ms: 1000, end_ms: 4000, source: 'slides' }]);
  expect(result.map(s => [s.start_ms, s.end_ms, s.source, s.edited])).toEqual([
    [0, 1000, 'screen', false], [1000, 2000, 'slides', true], [2000, 4000, 'slides', true], [4000, 6000, 'screen', false],
  ]);
  expect(contentAt(result, 1500).original_source).toBe('screen');
  expect(contentAt(result, 4000).source).toBe('screen');
  expect(contentAt(result, 6000).source).toBe('screen');
  expect(contentAt(result, -1)).toBeUndefined();
  expect(original[0].end_ms).toBe(2000);
});

test('replacement splits existing overrides and restoring recorded switches removes only the selected part', () => {
  const edited = replaceContentOverride([{ start_ms: 0, end_ms: 6000, source: 'screen' }], { start_ms: 2000, end_ms: 4000 }, 'slides');
  expect(edited).toEqual([{ start_ms: 0, end_ms: 2000, source: 'screen' }, { start_ms: 2000, end_ms: 4000, source: 'slides' }, { start_ms: 4000, end_ms: 6000, source: 'screen' }]);
  expect(replaceContentOverride(edited, { start_ms: 2000, end_ms: 4000 }, 'original')).toEqual([edited[0], edited[2]]);
  expect(replaceContentOverride(edited, { start_ms: 2000, end_ms: 4000 }, 'screen')).toEqual([{ start_ms: 0, end_ms: 6000, source: 'screen' }]);
});

test('choices validate the entire interval, including unavailable sources and protected areas', () => {
  const selection = { start_ms: 1000, end_ms: 5000 };
  expect(contentChoiceReason(recording, original, selection, 'slides')).toBe('');
  expect(contentChoiceReason(recording, [original[0], { ...original[1], screen_available: false }, original[2]], selection, 'screen')).toBe('contentMissingSource');
  expect(contentChoiceReason(recording, [original[0], { ...original[1], editable: false }, original[2]], selection, 'slides')).toBe('contentProtectedRange');
  expect(contentChoiceReason({ ...recording, content_edit_supported: false }, original, selection, 'screen')).toBe('contentUnsupported');
  expect(contentChoiceReason(recording, original, { start_ms: null, end_ms: 5000 }, 'original')).toBe('contentSelectRange');
  expect(contentChoiceReason(recording, original, selection, 'original')).toBe('');
});

test('the visible band merges availability-only boundaries while preserving edits and original-source differences', () => {
  const segments = applyContentOverrides([segment(0, 1000, 'slides', { screen_available: false }), segment(1000, 2000, 'slides')]);
  expect(displayContentSegments(segments)).toHaveLength(1);
  expect(segments[0].end_ms).toBe(1000);
  expect(displayContentSegments(applyContentOverrides(original, [{ start_ms: 0, end_ms: 6000, source: 'slides' }]))).toHaveLength(3);
});

test('server decisions are authoritative and older manifests use an explicitly inferred fallback', () => {
  expect(originalContentSegments({ content_segments: original })).toBe(original);
  const fallback = originalContentSegments({ duration_ms: 6000, assets: [{ kind: 'deskshare', start_ms: 1000, end_ms: 5000, has_video: true }], slides: [], events: [] });
  expect(fallback.map(s => s.source)).toEqual(['none', 'screen', 'none']);
  expect(fallback.every(s => s.inferred && !s.editable)).toBe(true);
});
