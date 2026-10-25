import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import DetailWaveform, { chunkIndexes } from './DetailWaveform';
import { EditorLanguageProvider, LANGUAGE_KEY } from './i18n';

const url = '/recording-editor/api/recordings/demo/preview/aaaaaaaaaaaaaaaaaaaaaaaa/audio.webm';
const tile = index => ({ start_ms: index * 10000, step_ms: 10, min: Array(1000).fill(-0.2), max: Array(1000).fill(0.4) });
let root, container, props, context;
const originalFetch = global.fetch;
async function render(changes = {}) {
  props = { ...props, ...changes };
  await act(async () => root.render(<EditorLanguageProvider><DetailWaveform {...props} /></EditorLanguageProvider>));
}
async function advance(ms = 150) { await act(async () => { jest.advanceTimersByTime(ms); }); }
const requests = () => global.fetch.mock.calls.map(([path]) => path);
const pointer = async (type, x, shiftKey = false) => {
  const element = container.querySelector('.re-detail-plot');
  element.getBoundingClientRect = () => ({ left: 100, width: 500 });
  element.setPointerCapture = jest.fn();
  await act(async () => Simulate[type](element, { button: 0, clientX: x, shiftKey, pointerId: 1, currentTarget: element }));
};
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true; jest.useFakeTimers();
  localStorage.setItem(LANGUAGE_KEY, 'en');
  context = { scale: jest.fn(), beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(), stroke: jest.fn() };
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  jest.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  jest.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(144);
  global.fetch = jest.fn(async path => ({ ok: true, json: async () => tile(Number(path.split('/').pop())) }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  props = { audioUrl: url, duration: 10800000, time: 68000, playing: false,
    selection: { start_ms: 0, end_ms: 0 }, setSelection: jest.fn(), seek: jest.fn(), span: 10000, setSpan: jest.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); localStorage.clear();
  jest.useRealTimers(); jest.restoreAllMocks(); global.fetch = originalFetch;
});

test('tiles cover just the visible time, including exact boundaries and the final partial tile', () => {
  expect(chunkIndexes(0, 10000, 10800000)).toEqual([0]);
  expect(chunkIndexes(4075000, 10000, 10800000)).toEqual([407, 408]);
  expect(chunkIndexes(10000, 30000, 10800000)).toEqual([1, 2, 3]);
  expect(chunkIndexes(10800000 - 15000, 30000, 10800000)).toEqual([1078, 1079]);
});

test('opening only requests visible tiles; playback ticks neither fetch nor redraw the waveform', async () => {
  await render(); expect(requests()).toEqual([]); await advance();
  expect(requests()).toEqual([url.replace('audio.webm', 'waveform/6'), url.replace('audio.webm', 'waveform/7')]);
  expect(container.querySelector('[role="status"]')).toBeNull();
  const strokes = context.stroke.mock.calls.length;
  await render({ time: 68200, playing: true }); await advance();
  expect(requests()).toHaveLength(2);
  expect(context.stroke.mock.calls).toHaveLength(strokes);
  expect(container.querySelector('.re-detail-playhead').style.left).toBe('52%');
});

test('playback prefetches only the next tile, pages at 90%, and returns to cached views without more fetches', async () => {
  await render(); await advance();
  await render({ time: 69600, playing: true }); await advance();
  expect(requests().map(p => p.split('/').pop())).toEqual(['6', '7', '8']);
  await render({ time: 72200 }); await advance();
  expect(container.querySelector('.re-detail-ruler').textContent).toContain('00:01:11.200');
  expect(requests()).toHaveLength(3);
  await render({ time: 68000, playing: false }); await advance();
  expect(requests()).toHaveLength(3);
});

test('rapid distant seeks are debounced and stale requests cannot overwrite the latest view', async () => {
  let resolve;
  global.fetch.mockImplementationOnce((_, options) => new Promise(done => { resolve = done; }));
  await render(); await advance();
  const oldSignal = global.fetch.mock.calls[0][1].signal;
  await render({ time: 4000000 }); await render({ time: 8000000 });
  expect(oldSignal.aborted).toBe(true); await advance();
  expect(requests().map(p => p.split('/').pop())).toEqual(['6', '799', '800']);
  await act(async () => resolve({ ok: true, json: async () => tile(6) }));
  expect(requests()).toHaveLength(3);
  expect(container.querySelector('.re-detail-ruler').textContent).toContain('02:13:15.000');
});

test('click preserves selection, Shift-click anchors to playhead, and dragging shares millisecond intervals', async () => {
  await render(); await advance();
  await pointer('pointerDown', 200); await pointer('pointerUp', 200);
  expect(props.seek).toHaveBeenLastCalledWith(65000); expect(props.setSelection).not.toHaveBeenCalled();
  props.seek.mockClear();
  await pointer('pointerDown', 125, true);
  expect(props.setSelection).toHaveBeenLastCalledWith({ start_ms: 63500, end_ms: 68000 });
  expect(props.seek).not.toHaveBeenCalled();
  await pointer('pointerDown', 200); await pointer('pointerMove', 300); await pointer('pointerUp', 350);
  expect(props.setSelection).toHaveBeenLastCalledWith({ start_ms: 65000, end_ms: 68000 });
  expect(props.seek).toHaveBeenLastCalledWith(68000);
});

test('temporary capacity limits retry locally, and visible errors offer a retry without blocking other controls', async () => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 429 });
  await render(); await advance(); await advance(250);
  expect(requests()).toHaveLength(3); expect(container.querySelector('[role="status"]')).toBeNull();
  global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
  await render({ time: 90000 }); await advance();
  expect(container.textContent).toContain('Could not load');
  await act(async () => Simulate.click(container.querySelector('.re-detail-status button'))); await advance();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test('closing aborts the active request and never continues its tile queue', async () => {
  let resolve;
  global.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render(); await advance();
  const signal = global.fetch.mock.calls[0][1].signal;
  await act(async () => root.render(<div>closed</div>));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ ok: true, json: async () => tile(6) }));
  await advance(1000); expect(requests()).toHaveLength(1);
});
