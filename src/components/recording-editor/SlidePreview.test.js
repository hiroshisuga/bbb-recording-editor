import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import fs from 'fs';
import SlidePreview from './SlidePreview';
import { EditorLanguageProvider } from './i18n';

let mockEditor;
jest.mock('@bigbluebutton/tldraw/tldraw.css', () => ({}));
jest.mock('@bigbluebutton/tldraw', () => {
  // Use the installed Tldraw engine; only replace its React canvas shell.
  jest.spyOn(global.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: () => ({ width: 10 }) });
  const React = require('react');
  const actual = jest.requireActual('@bigbluebutton/tldraw');
  return {
    ...actual,
    Tldraw: function Canvas({ onMount, autoFocus }) {
      const ref = React.useRef(null);
      React.useLayoutEffect(() => {
        const element = ref.current;
        const editor = new actual.Editor({
          shapeUtils: actual.defaultShapeUtils,
          tools: [...actual.defaultTools, ...actual.defaultShapeTools],
          store: actual.createTLStore({ shapeUtils: actual.defaultShapeUtils }),
          getContainer: () => element,
          initialState: 'select',
        });
        editor.updateViewportScreenBounds();
        mockEditor = editor;
        onMount(editor);
        return () => editor.dispose();
      }, [onMount]);
      return <div ref={ref} className="tl-container" data-autofocus={String(autoFocus)}>
        <div className="tl-canvas"><div className="tl-image-container"><div className="tl-image" /></div></div>
      </div>;
    },
  };
});

const recording = {
  events: [
    { type: 'SharePresentationEvent', time_ms: 0, presentation: 'deck' },
    { type: 'GotoSlideEvent', time_ms: 0, page: 1 },
    { type: 'ResizeAndMoveSlideEvent', time_ms: 1000, camera: { widthRatio: 50, heightRatio: 50, xOffset: 10, yOffset: 20 } },
    { type: 'GotoSlideEvent', time_ms: 2000, page: 2 },
  ],
  slides: [1, 2].map(page => ({ presentation: 'deck', page, url: `/slide${page}.svg` })),
};
let container, root, styles;
const originalResizeObserver = global.ResizeObserver;
const render = time => act(async () => {
  root.render(<EditorLanguageProvider><SlidePreview recording={recording} time={time} /></EditorLanguageProvider>);
});
const wheel = deltaY => mockEditor.dispatch({
  type: 'wheel', name: 'wheel', delta: { x: 0, y: deltaY, z: 0 }, point: { x: 200, y: 100 },
  shiftKey: false, altKey: false, ctrlKey: false,
});

beforeEach(() => {
  jest.useFakeTimers();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, width: 600, height: 330, bottom: 330, right: 600,
  });
  styles = document.createElement('style');
  styles.textContent = fs.readFileSync(require.resolve('@bigbluebutton/tldraw/tldraw.css'), 'utf8')
    + fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
  document.head.appendChild(styles);
  container = document.createElement('div'); container.className = 'recording-editor';
  document.body.appendChild(container); root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); styles.remove();
  HTMLElement.prototype.getBoundingClientRect.mockRestore();
  global.ResizeObserver = originalResizeObserver;
  jest.clearAllTimers();
  jest.useRealTimers();
});
afterAll(() => jest.restoreAllMocks());

test('wheel gestures cannot pan a focused slide preview, including after recorded camera updates', async () => {
  await render(0);
  expect(container.querySelector('[data-autofocus]').dataset.autofocus).toBe('false');
  expect(mockEditor.getInstanceState().isReadonly).toBe(true);
  await act(async () => mockEditor.updateInstanceState({ isFocused: true }));
  for (const time of [0, 1000, 2000, 0]) {
    await render(time);
    const before = { ...mockEditor.getCamera() };
    await act(async () => { for (let i = 0; i < 4; i += 1) wheel(-100); });
    expect(mockEditor.getCamera()).toEqual(before);
  }
});

test('recorded zoom, slide changes and backwards seeks still set the camera', async () => {
  await render(0);
  const initial = { ...mockEditor.getCamera() };
  await render(1000);
  expect(mockEditor.getCamera().z).toBeCloseTo(initial.z * 2);
  expect(mockEditor.getCamera().y).not.toBe(initial.y);
  await render(2000);
  expect(mockEditor.getCamera()).toEqual(initial);
  await render(1000);
  expect(mockEditor.getCamera().z).toBeCloseTo(initial.z * 2);
  await render(0);
  expect(mockEditor.getCamera()).toEqual(initial);
});

test('image descendants cannot capture pointer events despite the bundled Tldraw styles', async () => {
  await render(0);
  for (const element of container.querySelectorAll('.re-slide, .re-slide *')) {
    expect(window.getComputedStyle(element).pointerEvents).toBe('none');
  }
});
