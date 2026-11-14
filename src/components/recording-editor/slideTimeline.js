import { mergeSlideShape } from './model';

const TYPES = new Set([
  'SharePresentationEvent', 'GotoSlideEvent', 'ResizeAndMoveSlideEvent',
  'AddTldrawShapeEvent', 'DeleteTldrawShapeEvent', 'UndoShapeEvent',
  'UndoAnnotationEvent', 'ClearPageEvent', 'ClearWhiteboardEvent',
]);
const empty = () => ({ presentation: null, page: 1, camera: null, pages: new Map(), lastPages: new Map() });
const pageKey = state => `${state.presentation}:${state.page}`;
const copy = state => ({ ...state, pages: new Map(state.pages), lastPages: new Map(state.lastPages) });

// A recording owns one cursor and a bounded set of checkpoints. Shape values
// are immutable; only a page first changed after a checkpoint copies its Map.
// Call at() after React commits, never mutate the cursor during rendering.
export function createSlideTimeline(source, { checkpointEvery = 500, maxCheckpoints = 16 } = {}) {
  if (!Number.isInteger(checkpointEvery) || checkpointEvery < 1 || !Number.isInteger(maxCheckpoints) || maxCheckpoints < 1) {
    throw new Error('Invalid slide checkpoint limits');
  }
  // Server events are time ordered. Preserve source order at equal timestamps.
  const events = source.filter(event => TYPES.has(event.type));
  const checkpoints = new Map();
  let state = empty(), position = 0, writable = new Set(), result;
  let processedEvents = 0;

  function writablePage(key) {
    if (!writable.has(key)) {
      state.pages.set(key, new Map(state.pages.get(key)));
      writable.add(key);
    }
    return state.pages.get(key);
  }

  function at(time) {
    let low = 0, high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (events[middle].time_ms <= time) low = middle + 1;
      else high = middle;
    }
    const target = low;
    let base = position <= target ? position : 0, saved;
    for (const [index, snapshot] of checkpoints) {
      if (index > base && index <= target) { base = index; saved = snapshot; }
    }
    const restored = base !== position;
    if (restored) {
      state = saved ? copy(saved) : empty();
      position = base;
      writable = new Set();
    }
    const changed = new Set();
    while (position < target) {
      const event = events[position];
      if (event.type === 'SharePresentationEvent') {
        state.presentation = event.presentation;
        state.page = state.lastPages.get(state.presentation) || event.page || 1;
        state.camera = null;
      } else if (event.type === 'GotoSlideEvent') {
        state.presentation = event.presentation || state.presentation;
        state.page = event.page;
        state.lastPages.set(state.presentation, state.page);
        state.camera = null;
      } else if (event.type === 'ResizeAndMoveSlideEvent') state.camera = event.camera;
      const key = `${event.presentation || state.presentation}:${event.page || state.page}`;
      if (event.type === 'AddTldrawShapeEvent') {
        const id = event.shape_id || event.shape?.id;
        if (id && event.shape) {
          const shapes = writablePage(key);
          shapes.set(id, mergeSlideShape(shapes.get(id) || {}, event.shape));
          changed.add(key);
        }
      } else if (['DeleteTldrawShapeEvent', 'UndoShapeEvent', 'UndoAnnotationEvent'].includes(event.type)) {
        if (state.pages.get(key)?.has(event.shape_id)) {
          writablePage(key).delete(event.shape_id);
          changed.add(key);
        }
      } else if (['ClearPageEvent', 'ClearWhiteboardEvent'].includes(event.type)) {
        if (state.pages.delete(key)) changed.add(key);
        writable.delete(key);
      }
      position += 1;
      processedEvents += 1;
      if (position % checkpointEvery === 0) {
        checkpoints.delete(position);
        checkpoints.set(position, copy(state));
        if (checkpoints.size > maxCheckpoints) checkpoints.delete(checkpoints.keys().next().value);
        writable.clear();
      }
    }
    const samePage = result && result.presentation === state.presentation && result.page === state.page;
    const shapes = samePage && !restored && !changed.has(pageKey(state))
      ? result.shapes : new Map(state.pages.get(pageKey(state)));
    if (!result || !samePage || result.camera !== state.camera || result.shapes !== shapes) {
      result = { presentation: state.presentation, page: state.page, camera: state.camera, shapes };
    }
    return result;
  }

  return { at, stats: () => ({ processedEvents, checkpoints: checkpoints.size, indexedEvents: events.length }) };
}
