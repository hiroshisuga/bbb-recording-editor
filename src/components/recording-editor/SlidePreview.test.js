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
const render = (time, source = recording) => act(async () => {
  root.render(<EditorLanguageProvider><SlidePreview recording={source} time={time} /></EditorLanguageProvider>);
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

test.each([
  { widthRatio: 50, heightRatio: 50, xOffset: -200.77533039647577, yOffset: -184.12334801762117 },
  { widthRatio: 50, heightRatio: 50, xOffset: -720, yOffset: -400.7577092511013 },
  { widthRatio: 100, heightRatio: 100, xOffset: 0, yOffset: -93.9912023334251 },
])('recorded pan offsets remain in slide coordinates and keep the background visible: %j', async camera => {
  const source = { ...recording, events: recording.events.map(event => event.camera ? { ...event, camera } : event) };
  await render(0, source);
  const initial = { ...mockEditor.getCamera() };
  await render(1000, source);
  const viewport = mockEditor.getViewportPageBounds();
  const background = [...mockEditor.getCurrentPageShapeIds()].map(id => mockEditor.getShape(id)).find(shape => shape.type === 'image');
  const bounds = mockEditor.getShapePageBounds(background);
  expect(Math.min(viewport.maxX, bounds.maxX) - Math.max(viewport.minX, bounds.minX)).toBeGreaterThan(0);
  expect(Math.min(viewport.maxY, bounds.maxY) - Math.max(viewport.minY, bounds.minY)).toBeGreaterThan(0);
  const center = mockEditor.pageToScreen({
    x: -camera.xOffset + 1440 * camera.widthRatio / 200,
    y: -camera.yOffset + 1080 * camera.heightRatio / 200,
  });
  expect(center.x).toBeCloseTo(300);
  expect(center.y).toBeCloseTo(165);
  await render(2000, source);
  expect(mockEditor.getCamera()).toEqual(initial);
  await render(1000, source);
  const afterSeek = mockEditor.pageToScreen({
    x: -camera.xOffset + 1440 * camera.widthRatio / 200,
    y: -camera.yOffset + 1080 * camera.heightRatio / 200,
  });
  expect(afterSeek.x).toBeCloseTo(300);
  expect(afterSeek.y).toBeCloseTo(165);
});

test('image descendants cannot capture pointer events despite the bundled Tldraw styles', async () => {
  await render(0);
  for (const element of container.querySelectorAll('.re-slide, .re-slide *')) {
    expect(window.getComputedStyle(element).pointerEvents).toBe('none');
  }
});

const addShape = (time_ms, id, patch = {}, page = 1) => ({
  type: 'AddTldrawShapeEvent', time_ms, presentation: 'deck', page, shape_id: id,
  shape: { id, type: 'geo', x: 10, y: 20, props: { w: 100, h: 50 }, ...patch },
});
const annotationSource = extra => ({
  ...recording,
  events: [recording.events[0], addShape(100, 'shape:a'), addShape(100, 'shape:b'), ...extra],
});
const spyOnDrawing = () => Object.fromEntries(['createShapes', 'updateShapes', 'deleteShapes', 'setCamera', 'updateAssets']
  .map(name => [name, jest.spyOn(mockEditor, name)]));
const assertNoDrawing = spies => Object.values(spies).forEach(spy => expect(spy).not.toHaveBeenCalled());

test('idle ticks, chat and hidden-page annotations do not touch Tldraw', async () => {
  const source = annotationSource([
    { type: 'SendPublicChatEvent', time_ms: 200, message: 'chat' },
    addShape(300, 'shape:c', {}, 2),
  ]);
  await render(100, source);
  const spies = spyOnDrawing();
  for (const time of [150, 200, 250, 300, 350]) await render(time, source);
  assertNoDrawing(spies);
  expect(mockEditor.getShape('shape:a')).toBeDefined();
  expect(mockEditor.getShape('shape:c')).toBeUndefined();
});

test('camera updates preserve background and annotations without shape writes', async () => {
  const source = annotationSource([recording.events[2]]);
  await render(100, source);
  const spies = spyOnDrawing();
  await render(1000, source);
  expect(spies.setCamera).toHaveBeenCalled();
  ['createShapes', 'updateShapes', 'deleteShapes', 'updateAssets'].forEach(name => expect(spies[name]).not.toHaveBeenCalled());
});

test('updates only the changed shape and preserves an untouched shape object', async () => {
  const source = annotationSource([{ ...addShape(200, 'shape:a'), shape: { props: { w: 200 } } }]);
  await render(100, source);
  const untouched = mockEditor.getShape('shape:b');
  const spies = spyOnDrawing();
  await render(200, source);
  expect(mockEditor.getShape('shape:a').props).toMatchObject({ w: 200, h: 50 });
  expect(mockEditor.getShape('shape:b')).toBe(untouched);
  expect(spies.createShapes).not.toHaveBeenCalled();
  expect(spies.deleteShapes).not.toHaveBeenCalled();
  expect(spies.updateShapes).toHaveBeenCalledTimes(1);
  expect(spies.updateShapes.mock.calls[0][0][0].id).toBe('shape:a');
  await render(100, source);
  expect(mockEditor.getShape('shape:a').props.w).toBe(100);
});

test('backward seeks remove future fields and delete/recreate events restore defaults', async () => {
  const source = annotationSource([
    { ...addShape(200, 'shape:a'), shape: { props: { color: 'red' }, opacity: 0.5 } },
    { type: 'DeleteTldrawShapeEvent', time_ms: 300, shape_id: 'shape:a' },
    addShape(400, 'shape:a'),
  ]);
  await render(100, source);
  const initial = mockEditor.getShape('shape:a');
  await render(200, source);
  expect(mockEditor.getShape('shape:a').props.color).toBe('red');
  await render(100, source);
  expect(mockEditor.getShape('shape:a')).toMatchObject({ props: { color: initial.props.color }, opacity: initial.opacity });
  await render(200, source);
  await render(400, source);
  expect(mockEditor.getShape('shape:a')).toMatchObject({ props: { color: initial.props.color }, opacity: initial.opacity });
});

test('locked annotations, clear, page revisits and missing slides survive repeated seeks', async () => {
  const source = annotationSource([
    addShape(200, 'shape:locked', { isLocked: true }),
    { type: 'ClearPageEvent', time_ms: 300 },
    addShape(400, 'shape:other', {}, 2),
    { type: 'GotoSlideEvent', time_ms: 500, page: 2 },
    { type: 'GotoSlideEvent', time_ms: 600, page: 9 },
    { type: 'GotoSlideEvent', time_ms: 700, page: 1 },
  ]);
  await render(200, source);
  expect(mockEditor.getShape('shape:locked')).toBeDefined();
  await render(300, source);
  expect([...mockEditor.getCurrentPageShapeIds()].filter(id => !id.startsWith('shape:BG-'))).toEqual([]);
  await render(500, source);
  expect(mockEditor.getShape('shape:other')).toBeDefined();
  await render(600, source);
  expect(container.querySelector('.re-placeholder')).not.toBeNull();
  await render(700, source);
  expect(mockEditor.getShape('shape:other')).toBeUndefined();
  await render(200, source);
  expect(mockEditor.getShape('shape:locked')).toBeDefined();
  expect(mockEditor.getInstanceState().isReadonly).toBe(true);
});

test('invalid shapes are isolated and replacing recording events clears replay state', async () => {
  const source = annotationSource([addShape(200, 'shape:bad', { type: 'unrecognized' })]);
  await render(200, source);
  expect(mockEditor.getShape('shape:a')).toBeDefined();
  expect(mockEditor.getShape('shape:bad')).toBeUndefined();
  expect(container.querySelector('.re-render-warning')).not.toBeNull();
  const replacement = { ...recording, events: [recording.events[0], addShape(50, 'shape:new')] };
  await render(200, replacement);
  expect(mockEditor.getShape('shape:a')).toBeUndefined();
  expect(mockEditor.getShape('shape:new')).toBeDefined();
  expect(container.querySelector('.re-render-warning')).toBeNull();
});

test('arrow point metadata is sanitized and partial arrow updates survive backward seeks', async () => {
  const source = annotationSource([
    { type: 'AddTldrawShapeEvent', time_ms: 200, presentation: 'deck', page: 1, shape_id: 'shape:arrow', shape: {
      id: 'shape:arrow', type: 'arrow', isModerator: true,
      props: { start: { type: 'point', x: 0, y: 0, extra: 'recorded metadata' }, end: { type: 'point', x: 100, y: 100 } },
    } },
    { type: 'AddTldrawShapeEvent', time_ms: 300, shape_id: 'shape:arrow', shape: { props: { end: { x: 200 } } } },
  ]);
  await render(200, source);
  expect(mockEditor.getShape('shape:arrow').props.start).toEqual({ type: 'point', x: 0, y: 0 });
  await render(300, source);
  expect(mockEditor.getShape('shape:arrow').props.end).toEqual({ type: 'point', x: 200, y: 100 });
  await render(200, source);
  expect(mockEditor.getShape('shape:arrow').props.end.x).toBe(100);
  expect(container.querySelector('.re-render-warning')).toBeNull();
});

test('invalid partial updates do not leave the previous valid drawing on screen', async () => {
  const source = annotationSource([
    { type: 'AddTldrawShapeEvent', time_ms: 200, shape_id: 'shape:a', shape: { props: { color: 'invalid-recorded-color' } } },
  ]);
  await render(100, source);
  expect(mockEditor.getShape('shape:a')).toBeDefined();
  await render(200, source);
  expect(mockEditor.getShape('shape:a')).toBeUndefined();
  expect(mockEditor.getShape('shape:b')).toBeDefined();
  await render(100, source);
  expect(mockEditor.getShape('shape:a')).toBeDefined();
});

test('StrictMode replay leaves a live editor with the correct state', async () => {
  const source = annotationSource([]);
  await act(async () => root.render(<React.StrictMode><EditorLanguageProvider><SlidePreview recording={source} time={100} /></EditorLanguageProvider></React.StrictMode>));
  expect(mockEditor.getShape('shape:a')).toBeDefined();
  expect(mockEditor.getShape('shape:b')).toBeDefined();
  expect(mockEditor.getInstanceState().isReadonly).toBe(true);
});
