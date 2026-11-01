import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import PreviewPanes from './PreviewPanes';
import useEditorPreferences, { PREFERENCES_KEY, readPreferences } from './preferences';
import { EditorLanguageProvider } from './i18n';

let container, root, handle;
function Harness() {
  const [preferences, update] = useEditorPreferences();
  return <PreviewPanes ratio={preferences.previewSplit} onChange={previewSplit => update({ previewSplit })}
    content={<iframe title="external video" />} cameras={<video />} />;
}
const pointer = (type, values = {}) => act(() => Simulate[type](handle,
  { pointerId: 1, button: 0, isPrimary: true, clientX: 750, ...values }));
const key = (value, shiftKey = false) => act(() => Simulate.keyDown(handle, { key: value, shiftKey }));
const ratio = () => Number(handle.getAttribute('aria-valuenow'));

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.removeItem(PREFERENCES_KEY);
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<EditorLanguageProvider><Harness /></EditorLanguageProvider>));
  handle = container.querySelector('[role=separator]');
  container.querySelector('.re-preview').getBoundingClientRect = () => ({ width: 1014 });
  handle.getBoundingClientRect = () => ({ width: 14 });
  handle.setPointerCapture = jest.fn();
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); localStorage.removeItem(PREFERENCES_KEY);
});

test('dragging resizes immediately, persists on release, and keeps media elements mounted', () => {
  const video = container.querySelector('video');
  const iframe = container.querySelector('iframe');
  pointer('pointerDown');
  expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
  pointer('pointerMove', { clientX: 500 });
  expect(ratio()).toBe(50);
  expect(readPreferences().previewSplit).toBe(0.75);
  expect(container.querySelector('.re-preview--resizing')).not.toBeNull();
  pointer('pointerUp', { clientX: 500 });
  expect(readPreferences().previewSplit).toBe(0.5);
  expect(container.querySelector('.re-preview--resizing')).toBeNull();
  expect(container.querySelector('video')).toBe(video);
  expect(container.querySelector('iframe')).toBe(iframe);
});

test('only the primary left pointer can resize, and cancellation restores the saved split', () => {
  pointer('pointerDown', { button: 2 }); pointer('pointerMove', { clientX: 100 });
  expect(ratio()).toBe(75);
  pointer('pointerDown');
  pointer('pointerDown', { pointerId: 2, isPrimary: false });
  pointer('pointerMove', { pointerId: 2, clientX: 100 });
  expect(ratio()).toBe(75);
  pointer('pointerMove', { clientX: 400 }); expect(ratio()).toBe(40);
  pointer('pointerCancel'); pointer('lostPointerCapture');
  expect(ratio()).toBe(75);
  expect(readPreferences().previewSplit).toBe(0.75);
});

test('drag bounds keep both panes visible; losing capture commits and ends the drag', () => {
  pointer('pointerDown'); pointer('pointerMove', { clientX: -1000 });
  expect(ratio()).toBe(20);
  pointer('pointerMove', { clientX: 2000 }); expect(ratio()).toBe(80);
  pointer('lostPointerCapture');
  expect(readPreferences().previewSplit).toBe(0.8);
  expect(container.querySelector('.re-preview--resizing')).toBeNull();
  pointer('pointerMove', { clientX: 400 }); expect(ratio()).toBe(80);
});

test('keyboard controls and reset persist, and a remount restores the selected ratio', () => {
  key('ArrowLeft'); expect(ratio()).toBe(73);
  key('ArrowLeft', true); expect(ratio()).toBe(63);
  key('Home'); expect(ratio()).toBe(20);
  key('ArrowLeft'); expect(ratio()).toBe(20);
  key('End'); expect(ratio()).toBe(80);
  key('ArrowRight'); expect(ratio()).toBe(80);
  act(() => Simulate.doubleClick(handle)); expect(ratio()).toBe(75);
  key('ArrowRight', true); expect(ratio()).toBe(80);
  key('ArrowLeft', true); expect(ratio()).toBe(70);
  act(() => root.unmount());
  root = createRoot(container);
  act(() => root.render(<EditorLanguageProvider><Harness /></EditorLanguageProvider>));
  handle = container.querySelector('[role=separator]');
  expect(ratio()).toBe(70);
});
