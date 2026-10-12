import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import TimelineTooltip from './TimelineTooltip';

let container, root, target, second;
const tooltip = () => document.querySelector('[role="tooltip"]');
const advance = ms => act(() => jest.advanceTimersByTime(ms));
const pointer = (element, name, options = {}) => act(() => element.dispatchEvent(new MouseEvent(name,
  { bubbles: true, clientX: 100, clientY: 100, ...options })));

function Harness() {
  const ref = useRef(null);
  return <><div ref={ref}><button data-tooltip={'Lecture <A>.pptx\n00:00:01 – 00:00:10'} aria-describedby="existing">One<span>child</span></button>
    <button data-tooltip="Slide 2">Two</button></div><TimelineTooltip targetRef={ref} /></>;
}

beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
  [target, second] = container.querySelectorAll('button');
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); jest.restoreAllMocks(); });

test('shows after 150ms, preserves text and existing descriptions, and does not reset within one target', () => {
  pointer(target, 'pointerover'); advance(100);
  expect(tooltip()).toBeNull();
  pointer(target, 'pointerout', { relatedTarget: target.querySelector('span') });
  pointer(target.querySelector('span'), 'pointerover'); advance(49);
  expect(tooltip()).toBeNull(); advance(1);
  expect(tooltip().textContent).toBe('Lecture <A>.pptx\n00:00:01 – 00:00:10');
  expect(tooltip().querySelector('a')).toBeNull();
  expect(container.contains(tooltip())).toBe(false);
  expect(target.getAttribute('aria-describedby')).toBe(`existing ${tooltip().id}`);
  pointer(target, 'pointerout');
  expect(tooltip()).toBeNull(); expect(target.getAttribute('aria-describedby')).toBe('existing');
});

test('cancels brief hovers and replaces a pending target without showing stale content', () => {
  pointer(target, 'pointerover'); advance(100); pointer(target, 'pointerout'); advance(150);
  expect(tooltip()).toBeNull();
  pointer(target, 'pointerover'); advance(100); pointer(second, 'pointerover'); advance(50);
  expect(tooltip()).toBeNull(); advance(100);
  expect(tooltip().textContent).toBe('Slide 2');
});

test('keyboard focus is immediate, Escape dismisses, and metadata updates refresh visible text', async () => {
  act(() => target.focus());
  expect(tooltip()).not.toBeNull();
  await act(async () => { target.dataset.tooltip = 'Updated filename'; });
  expect(tooltip().textContent).toBe('Updated filename');
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(tooltip()).toBeNull();
  act(() => second.focus()); expect(tooltip().textContent).toBe('Slide 2');
  act(() => second.blur()); expect(tooltip()).toBeNull();
});

test('click/drag, scrolling, resize and window blur hide tooltips and pending timers', () => {
  for (const dismiss of [() => pointer(target, 'pointerdown'),
    () => act(() => container.firstChild.dispatchEvent(new Event('scroll'))),
    () => act(() => window.dispatchEvent(new Event('resize'))),
    () => act(() => window.dispatchEvent(new Event('blur')))]) {
    pointer(target, 'pointerover'); advance(150); expect(tooltip()).not.toBeNull();
    dismiss(); expect(tooltip()).toBeNull(); advance(150); expect(tooltip()).toBeNull();
  }
  pointer(target, 'pointerover'); pointer(target, 'pointerdown'); advance(150);
  expect(tooltip()).toBeNull();
  pointer(target, 'pointerover', { buttons: 1 }); advance(150); expect(tooltip()).toBeNull();
});

test('clamps tooltip bounds at the viewport edges', () => {
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 60 });
  pointer(target, 'pointerover', { clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 }); advance(150);
  expect(parseFloat(tooltip().style.left)).toBe(window.innerWidth - 208);
  expect(parseFloat(tooltip().style.top)).toBe(window.innerHeight - 74);
});

test('pointer-driven focus after a click does not reopen the tooltip, but keyboard focus still does', () => {
  pointer(target, 'pointerover'); advance(150);
  pointer(target, 'pointerdown'); act(() => target.focus());
  expect(tooltip()).toBeNull();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })));
  act(() => second.focus()); expect(tooltip().textContent).toBe('Slide 2');
});

test('unmount clears pending timers and tooltip accessibility attributes', async () => {
  pointer(target, 'pointerover');
  await act(async () => root.unmount());
  expect(jest.getTimerCount()).toBe(0); expect(tooltip()).toBeNull();
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  target = container.querySelector('button'); act(() => target.focus());
  await act(async () => root.unmount());
  expect(tooltip()).toBeNull(); expect(target.getAttribute('aria-describedby')).toBe('existing');
  root = createRoot(container);
});
