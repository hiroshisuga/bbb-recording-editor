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
async function pointer(type, clientX, clientY = 100) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { clientX, clientY, pointerId: 1 });
  await act(async () => window.dispatchEvent(event));
}

test('clicking past the paging threshold keeps following after pointer release', async () => {
  await render({ playing: true, time: 8000 });
  await act(async () => Simulate.pointerDown(container.querySelector('button'), { button: 0, clientX: 950, clientY: 100, pointerId: 1 }));
  await pointer('pointerup', 950);
  await render({ time: 9500 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 800, behavior: 'smooth' });
  await scroll(800);
  await render({ time: 17000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 1600, behavior: 'smooth' });
});

test('a click resumes following after manually browsing another timeline page', async () => {
  await render({ playing: true, time: 8000 });
  await scroll(1000);
  await render({ time: 30000 });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  await act(async () => Simulate.pointerDown(container.querySelector('button'), { button: 0, clientX: 950, clientY: 100, pointerId: 1 }));
  await pointer('pointerup', 950);
  await render({ time: 19500 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 1800, behavior: 'smooth' });
});

test('a drag detected at pointer release still suspends following', async () => {
  await render({ playing: true, time: 8000 });
  await act(async () => Simulate.pointerDown(container.querySelector('button'), { button: 0, clientX: 500, clientY: 100, pointerId: 1 }));
  await pointer('pointerup', 550);
  await render({ time: 30000 });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
});

test('clicking the scrollbar does not undo manual-scroll suspension on release', async () => {
  await render({ playing: true, time: 8000 });
  await act(async () => Simulate.pointerDown(scroller, { button: 0, clientX: 950, clientY: 100, pointerId: 1 }));
  await scroll(1000);
  await pointer('pointerup', 950);
  await render({ time: 30000 });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
});

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
  if (kind === 'pointer') {
    await act(async () => Simulate.pointerDown(container.querySelector('button'), { button: 0, clientX: 500, clientY: 100, pointerId: 1 }));
    await pointer('pointermove', 550);
    await pointer('pointerup', 550);
  }
  else if (kind === 'scrollbar') await scroll(300);
  else if (kind === 'keyboard') await act(async () => Simulate.keyDown(scroller, { key: 'ArrowRight' }));
  else await act(async () => Simulate.wheel(scroller, { deltaX: 0, deltaY: 100, shiftKey: true }));
  await render({ time: 30000 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
});

test('pause stops an animation and zoom changes center the playhead before playback follows', async () => {
  await render({ playing: true, time: 9000 });
  await scroll(300);
  await render({ playing: false });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'auto' });
  await render({ playing: true, zoom: 8, time: 15000 });
  expect(scroller.scrollLeft).toBe(2500);
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'auto' });
});

test('restarting playback while a range is being dragged does not move the viewport until release', async () => {
  await render({ playing: true });
  await act(async () => Simulate.pointerDown(container.querySelector('button'), { button: 0, clientX: 500, clientY: 100, pointerId: 1 }));
  await pointer('pointermove', 550);
  await render({ playing: false, time: 30000 });
  await render({ playing: true });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  await pointer('pointerup', 550);
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


test('zooming in and out while paused keeps the playhead centered without moving playback', async () => {
  await render({ zoom: 1, time: 20000 });
  expect(scroller.scrollLeft).toBe(0);
  await render({ zoom: 4 });
  expect(scroller.scrollLeft).toBe(1500);
  await render({ zoom: 8 });
  expect(scroller.scrollLeft).toBe(3500);
  await render({ zoom: 2 });
  expect(scroller.scrollLeft).toBe(500);
  await render({ zoom: 1 });
  expect(scroller.scrollLeft).toBe(0);
  expect(options.time).toBe(20000);
  expect(scroller.scrollTo).not.toHaveBeenCalled();
});

test.each([[100, 0], [39900, 15000], [40000, 15000]])('zoom clamps to the scrollable bounds near %sms', async (time, left) => {
  await render({ zoom: 1, time });
  await render({ zoom: 16 });
  expect(scroller.scrollLeft).toBe(left);
});

test('centering after a zoom is not treated as manual scrolling and playback still pages at 90%', async () => {
  await render({ zoom: 1, time: 20000, playing: true });
  await render({ zoom: 4 });
  expect(scroller.scrollLeft).toBe(1500);
  await scroll(1500);
  await render({ time: 23900 });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  await render({ time: 24000 });
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 2300, behavior: 'smooth' });
});

test('zoom centers even after manual navigation suspended playback following', async () => {
  await render({ playing: true, time: 20000 });
  await scroll(1900);
  await act(async () => Simulate.wheel(scroller, { deltaX: 100, deltaY: 0 }));
  await render({ zoom: 8 });
  expect(scroller.scrollLeft).toBe(3500);
  const calls = scroller.scrollTo.mock.calls.length;
  await scroll(3500);
  await render({ time: 30000 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(calls);
});

test('zoom interrupts a paging animation and immediately centers using the new width', async () => {
  await render({ playing: true, time: 9000 });
  await scroll(300);
  await render({ zoom: 8 });
  expect(scroller.scrollLeft).toBe(1300);
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'auto' });
  const calls = scroller.scrollTo.mock.calls.length;
  await scroll(1300);
  await render({ time: 9500 });
  expect(scroller.scrollTo).toHaveBeenCalledTimes(calls);
});
