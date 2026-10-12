import { formatTime, parseTime, normalizeRanges, removeRange, externalVideos, presentationRanges, slideState } from './model';

test('millisecond clock and invalid input', () => {
  expect(formatTime(3723045)).toBe('01:02:03.045');
  expect(parseTime('01:02:03.045')).toBe(3723045);
  expect(parseTime('02:03.4')).toBe(123400);
  expect(parseTime('00:60:00')).toBeNull();
});

test('record-off selection splits an existing recording interval', () => {
  expect(removeRange([{ start_ms: 0, end_ms: 6000 }], { start_ms: 2000, end_ms: 4000 }, 6000))
    .toEqual([{ start_ms: 0, end_ms: 2000 }, { start_ms: 4000, end_ms: 6000 }]);
  expect(normalizeRanges([{ start_ms: 0, end_ms: 2000 }, { start_ms: 1000, end_ms: 7000 }], 6000))
    .toEqual([{ start_ms: 0, end_ms: 6000 }]);
});

test('external video states use status as type and state as playing', () => {
  const videos = externalVideos([
    { type: 'StartExternalVideoRecordEvent', time_ms: 1000, url: 'https://example.com/video.mp4', title: 'Recorded title' },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 2000, status: 'seek', state: '0', position: '45', rate: '1' },
    { type: 'StopExternalVideoRecordEvent', time_ms: 5000 },
  ], 6000);
  expect(videos[0].clear).toBe(5);
  expect(videos[0].title).toBe('Recorded title');
  expect(videos[0].events[0]).toMatchObject({ timestamp: 2, type: 'seek', playing: false, time: '45' });
});

test('external sharing ends at stop, replacement or meeting end and ignores orphan updates', () => {
  const videos = externalVideos([
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 0, status: 'seek' },
    { type: 'StartExternalVideoRecordEvent', time_ms: 1000, url: 'first' },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 2000, status: 'pause', state: '0' },
    { type: 'StartExternalVideoRecordEvent', time_ms: 3000, url: 'replacement' },
    { type: 'StopExternalVideoRecordEvent', time_ms: 4000 },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 4500, status: 'play' },
    { type: 'StartExternalVideoRecordEvent', time_ms: 5000, url: 'open-ended' },
  ], 6000);
  expect(videos.map(video => [video.timestamp, video.clear])).toEqual([[1, 3], [3, 4], [5, 6]]);
  expect(videos[0].events[0].playing).toBe(false);
  expect(videos[1].events).toEqual([]);
});

test('whiteboard partial updates, slide changes, deletions and backwards seeks', () => {
  const events = [
    { type: 'SharePresentationEvent', time_ms: 0, presentation: 'deck', page: 1 },
    { type: 'AddTldrawShapeEvent', time_ms: 100, presentation: 'deck', page: 1, shape_id: 'shape:a', shape: { id: 'shape:a', props: { w: 50, h: 20 }, x: 1 } },
    { type: 'AddTldrawShapeEvent', time_ms: 200, presentation: 'deck', page: 1, shape_id: 'shape:a', shape: { props: { w: 100 }, x: 2 } },
    { type: 'GotoSlideEvent', time_ms: 300, presentation: 'deck', page: 2 },
    { type: 'GotoSlideEvent', time_ms: 400, presentation: 'deck', page: 1 },
    { type: 'DeleteTldrawShapeEvent', time_ms: 500, presentation: 'deck', page: 1, shape_id: 'shape:a' },
  ];
  expect(slideState(events, 450).shapes[0]).toMatchObject({ x: 2, props: { w: 100, h: 20 } });
  expect(slideState(events, 550).shapes).toEqual([]);
  expect(slideState(events, 150).shapes[0].x).toBe(1);
  expect(slideState(events, 350).page).toBe(2);
});

test('presentation ribbons stay continuous across navigation, repeat sharing and content overlays', () => {
  const events = [
    { type: 'SharePresentationEvent', time_ms: 1000, presentation: 'deck A', share: 'true' },
    { type: 'GotoSlideEvent', time_ms: 1000, presentation: 'deck A', page: 1 },
    { type: 'GotoSlideEvent', time_ms: 2000, presentation: 'deck A', page: 2 },
    { type: 'SharePresentationEvent', time_ms: 2500, presentation: 'deck A' },
    { type: 'StartExternalVideoRecordEvent', time_ms: 3000 },
    { type: 'SetScreenshareAsContentEvent', time_ms: 3200, fields: { screenshare: 'true' } },
    { type: 'SetPresentationIsOpenEvent', time_ms: 3400, fields: { isOpen: 'false' } },
    { type: 'ResizeAndMoveSlideEvent', time_ms: 3500 },
    { type: 'StopExternalVideoRecordEvent', time_ms: 4000 },
    { type: 'SharePresentationEvent', time_ms: 5000, presentation: 'deck B' },
    { type: 'GotoSlideEvent', time_ms: 5500, presentation: 'deck B', page: 2 },
  ];
  const ranges = presentationRanges(events, 6000);
  expect(ranges.map(r => [r.presentation, r.start_ms, r.end_ms])).toEqual([['deck A', 1000, 5000], ['deck B', 5000, 6000]]);
  expect(ranges[0].events.map(e => e.time_ms)).toEqual([2000, 3500]);
  expect(ranges[1].events[0].page).toBe(2);
});

test('presentation unsharing creates a gap and returning to the same deck starts another ribbon', () => {
  const ranges = presentationRanges([
    { type: 'SharePresentationEvent', time_ms: 1000, presentation: 'A' },
    { type: 'SharePresentationEvent', time_ms: 2000, presentation: 'B', share: false },
    { type: 'SharePresentationEvent', time_ms: 3000, presentation: 'A', share: 'false' },
    { type: 'ResizeAndMoveSlideEvent', time_ms: 3500 },
    { type: 'SharePresentationEvent', time_ms: 4000, presentation: 'A', share: true },
    { type: 'SharePresentationEvent', time_ms: 5000, presentation: 'A', share: false },
  ], 6000);
  expect(ranges.map(r => [r.start_ms, r.end_ms])).toEqual([[1000, 3000], [4000, 5000]]);
  expect(ranges.every(r => r.events.length === 0)).toBe(true);
});

test('older recordings infer the presentation from goto events, including changes without sharing', () => {
  expect(presentationRanges([], 6000)).toEqual([]);
  const ranges = presentationRanges([
    { type: 'GotoSlideEvent', time_ms: 1000, presentation: 'A', page: 2 },
    { type: 'GotoSlideEvent', time_ms: 2000, page: 3 },
    { type: 'GotoSlideEvent', time_ms: 3000, presentation: 'B', page: 1 },
    { type: 'GotoSlideEvent', time_ms: 4000, presentation: 'B', page: 2 },
  ], 6000);
  expect(ranges.map(r => [r.presentation, r.start_ms, r.end_ms])).toEqual([['A', 1000, 3000], ['B', 3000, 6000]]);
  expect(ranges.map(r => r.events.map(e => e.time_ms))).toEqual([[2000], [4000]]);
});

test('same-timestamp unshare and reshare leave a single continuous presentation ribbon', () => {
  const ranges = presentationRanges([
    { type: 'SharePresentationEvent', time_ms: 1000, presentation: 'A' },
    { type: 'GotoSlideEvent', time_ms: 2000, presentation: 'A', page: 2 },
    { type: 'SharePresentationEvent', time_ms: 3000, presentation: 'A', share: false },
    { type: 'SharePresentationEvent', time_ms: 3000, presentation: 'A', share: true },
  ], 6000);
  expect(ranges).toHaveLength(1);
  expect(ranges[0]).toMatchObject({ start_ms: 1000, end_ms: 6000 });
  expect(ranges[0].events[0].page).toBe(2);
});
