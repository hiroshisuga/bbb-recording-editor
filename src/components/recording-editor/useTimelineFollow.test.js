import React, { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import useTimelineFollow from './useTimelineFollow';

function Probe(options) {
  const scrollRef = useRef(null);
  const timelineRef = useRef(null);
  useLayoutEffect(() => {
    Object.defineProperties(scrollRef.current, {
      clientWidth: { configurable: true, value: 1000 },
      scrollWidth: { configurable: true, value: options.zoom * 1000 },
    });
    Object.defineProperty(timelineRef.current, 'offsetWidth', { configurable: true, value: options.zoom * 1000 });
    if (!scrollRef.current.scrollTo) scrollRef.current.scrollTo = jest.fn();
  }, [options.zoom]);
  const events = useTimelineFollow(scrollRef, timelineRef, options);
  return <div ref={scrollRef} {...events}><div ref={timelineRef}><button>Drag range</button></div></div>;
}

let container, root, scroller;
const originalMatchMedia = window.matchMedia;
const defaults = { time: 0, duration: 40000, playing: false, zoom: 4, recordingId: 'meeting-one' };
let options;
async function render(changes = {}) {
  options = { ...options, ...changes };
  await act(async () => root.render(<Probe {...options} />));
  scroller = container.firstChild;
}
async function scroll(left) {
  scroller.scrollLeft = left;
  await act(async () => Simulate.scroll(scroller));
}

beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = jest.fn(() => ({ matches: false }));
  options = defaults;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); window.matchMedia = originalMatchMedia;
});

test('pages at 90%, advances by 80%, and ignores its own smooth-scroll events', async () => {
  await render({ playing: true, time: 8900 });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  await render({ time: 9000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 800, behavior: 'smooth' });
  await scroll(300); // Smooth animation is still on its way to 800.
  await render({ time: 9500 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  await scroll(800);
  await render({ time: 16900 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  await render({ time: 17000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 1600, behavior: 'smooth' });
});

test('seeks across several pages and backwards keep the playhead visible; the end is clamped', async () => {
  await render({ playing: true, time: 25000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 2400, behavior: 'smooth' });
  await scroll(2400);
  await render({ time: 1000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'smooth' });
  await scroll(0);
  await render({ time: 40000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 3000, behavior: 'smooth' });
  await scroll(3000);
  await render({ time: 40000 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(3);
});

test('paused playback and a timeline that fits the viewport do not scroll', async () => {
  await render({ time: 30000 });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  await render({ playing: true, zoom: 1 });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
});

test('horizontal wheel input interrupts an animation and suspends following until playback restarts', async () => {
  await render({ playing: true, time: 9000 });
  await scroll(300);
  await act(async () => Simulate.wheel(scroller, { deltaX: 50, deltaY: 0 }));
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'auto' });
  await scroll(1200);
  const calls = scroller.scrollTo.mock.calls.length;
  await render({ time: 30000 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(calls);
  await render({ playing: false });
  await render({ playing: true });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 2900, behavior: 'smooth' });
});

test.each(['pointer', 'scrollbar', 'keyboard', 'shift-wheel'])('%s navigation suspends follow while normal vertical wheel scrolling does not', async kind => {
  await render({ playing: true });
  await act(async () => Simulate.wheel(scroller, { deltaX: 0, deltaY: 100 }));
  await render({ time: 9000 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  await scroll(800);
  if (kind === 'pointer') await act(async () => Simulate.pointerDown(container.querySelector('button'), { button: 0 }));
  else if (kind === 'scrollbar') await scroll(300);
  else if (kind === 'keyboard') await act(async () => Simulate.keyDown(scroller, { key: 'ArrowRight' }));
  else await act(async () => Simulate.wheel(scroller, { deltaX: 0, deltaY: 100, shiftKey: true }));
  await render({ time: 30000 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
});

test('pause stops an animation and zoom changes recompute the visible position', async () => {
  await render({ playing: true, time: 9000 });
  await scroll(300);
  await render({ playing: false });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'auto' });
  await render({ playing: true, zoom: 8, time: 15000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 2900, behavior: 'smooth' });
});

test('restarting playback while a range is being dragged does not move the viewport until release', async () => {
  await render({ playing: true });
  await act(async () => Simulate.pointerDown(container.querySelector('button'), { button: 0 }));
  await render({ playing: false, time: 30000 });
  await render({ playing: true });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event('pointerup')));
  await render({ time: 30100 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 2910, behavior: 'smooth' });
});

test('a new recording resets manual suspension', async () => {
  await render({ playing: true });
  await scroll(1000);
  await render({ time: 30000 });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  await render({ recordingId: 'meeting-two' });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 2900, behavior: 'smooth' });
});

test('reduced motion uses an immediate scroll', async () => {
  window.matchMedia.mockReturnValue({ matches: true });
  await render({ playing: true, time: 9000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 800, behavior: 'auto' });
});

test('without scrollTo the fallback still moves only the scroll position', async () => {
  scroller.scrollTo = undefined;
  await render({ playing: true, time: 9000 });
  expect(scroller.scrollLeft).toBe(800);
  expect(options.time).toBe(9000);
});
