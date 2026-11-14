import { slideState } from './model';
import { createSlideTimeline } from './slideTimeline';

const shape = (time, id, patch, page = 1) => ({ type: 'AddTldrawShapeEvent', time_ms: time, presentation: 'deck', page, shape_id: id, shape: patch });
const events = [
  { type: 'SharePresentationEvent', time_ms: 0, presentation: 'deck', page: 1 },
  shape(10, 'shape:a', { id: 'shape:a', type: 'geo', x: 1, props: { w: 50, h: 20 } }),
  shape(20, 'shape:a', { x: 2, props: { w: 100 } }),
  shape(20, 'shape:b', { id: 'shape:b', x: 3 }, 2),
  { type: 'SendPublicChatEvent', time_ms: 25, message: 'irrelevant' },
  { type: 'ResizeAndMoveSlideEvent', time_ms: 30, camera: { xOffset: 20, widthRatio: 50 } },
  { type: 'GotoSlideEvent', time_ms: 40, presentation: 'deck', page: 2 },
  { type: 'UndoShapeEvent', time_ms: 50, shape_id: 'shape:b' },
  shape(60, 'shape:c', { id: 'shape:c', x: 4 }),
  { type: 'GotoSlideEvent', time_ms: 70, page: 1 },
  { type: 'UndoAnnotationEvent', time_ms: 80, shape_id: 'shape:a' },
  shape(80, 'shape:a', { id: 'shape:a', x: 10 }),
  { type: 'ClearWhiteboardEvent', time_ms: 90 },
  shape(100, 'shape:d', { id: 'shape:d', x: 5 }),
  { type: 'ClearPageEvent', time_ms: 110 },
  { type: 'SharePresentationEvent', time_ms: 120, presentation: 'other' },
  { type: 'GotoSlideEvent', time_ms: 130, presentation: 'other', page: 3 },
  { type: 'SharePresentationEvent', time_ms: 140, presentation: 'deck' },
  { type: 'DeleteTldrawShapeEvent', time_ms: 150, shape_id: 'missing' },
];
const comparable = state => ({ ...state, shapes: [...state.shapes.values()] });

test('matches full replay for forward, backward and same-timestamp seeks with checkpoint eviction', () => {
  const timeline = createSlideTimeline(events, { checkpointEvery: 3, maxCheckpoints: 2 });
  const times = [-1, 0, 9, 10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 140, 150,
    20, 100, 30, 140, -1, 150, 60, 20, 10, 130, 80];
  times.forEach(time => {
    expect(comparable(timeline.at(time))).toEqual(slideState(events, time));
    expect(timeline.stats().checkpoints).toBeLessThanOrEqual(2);
  });
});

test('retained checkpoints and published views cannot be mutated by subsequent replay', () => {
  const timeline = createSlideTimeline(events, { checkpointEvery: 2 });
  const first = timeline.at(10);
  const expected = comparable(first);
  timeline.at(150);
  expect(comparable(first)).toEqual(expected);
  expect(comparable(timeline.at(20))).toEqual(slideState(events, 20));
  expect(comparable(timeline.at(10))).toEqual(expected);
});

test('idle ticks, chat and hidden-page changes preserve the visible snapshot', () => {
  const timeline = createSlideTimeline(events);
  const first = timeline.at(20);
  const processed = timeline.stats().processedEvents;
  for (let i = 0; i < 100; i += 1) expect(timeline.at(25)).toBe(first);
  expect(timeline.stats().processedEvents).toBe(processed);
  const camera = timeline.at(30);
  expect(camera.shapes).toBe(first.shapes);
  expect(timeline.at(60).page).toBe(2);
  const hidden = timeline.at(60);
  expect(timeline.at(69)).toBe(hidden);
});

test('large forward seeks use the closest retained checkpoint and apply only the remaining events', () => {
  const many = [events[0], ...Array.from({ length: 5000 }, (_, i) => shape(i + 1, 'shape:a', { id: 'shape:a', x: i }))];
  const timeline = createSlideTimeline(many, { checkpointEvery: 500, maxCheckpoints: 16 });
  timeline.at(5000);
  timeline.at(10);
  const before = timeline.stats().processedEvents;
  expect(comparable(timeline.at(4998))).toEqual(slideState(many, 4998));
  expect(timeline.stats().processedEvents - before).toBeLessThan(500);
  expect(timeline.stats().indexedEvents).toBe(5001);
});

test('incremental replay scales with newly crossed events and excludes unrelated events', () => {
  const many = [events[0], ...Array.from({ length: 1000 }, (_, i) => [
    shape(i * 2 + 1, 'shape:a', { id: 'shape:a', x: i }),
    { type: 'ParticipantTalkingEvent', time_ms: i * 2 + 2 },
  ]).flat()];
  const timeline = createSlideTimeline(many);
  for (let time = 0; time <= 2000; time += 1) timeline.at(time);
  expect(timeline.stats()).toMatchObject({ processedEvents: 1001, indexedEvents: 1001 });
});

test('random seek order agrees with full replay across several pages and partial updates', () => {
  let seed = 1234;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const many = [events[0]];
  for (let i = 1; i <= 600; i += 1) {
    const page = 1 + random(4), id = `shape:${random(20)}`, kind = random(6);
    many.push(kind < 3 ? shape(i, id, { id, x: random(100), props: { w: random(100) } }, page)
      : kind === 3 ? { type: 'GotoSlideEvent', time_ms: i, presentation: 'deck', page }
        : { type: kind === 4 ? 'ClearPageEvent' : 'DeleteTldrawShapeEvent', time_ms: i, presentation: 'deck', page, shape_id: id });
  }
  const timeline = createSlideTimeline(many, { checkpointEvery: 31, maxCheckpoints: 4 });
  for (let i = 0; i < 200; i += 1) {
    const time = random(602) - 1;
    expect(comparable(timeline.at(time))).toEqual(slideState(many, time));
  }
});
