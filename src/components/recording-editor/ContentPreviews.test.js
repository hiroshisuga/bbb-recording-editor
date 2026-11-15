import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import ContentPreviews, { previewContentSources } from './ContentPreviews';
import SlidePreview from './SlidePreview';
import VideoPreview from './VideoPreview';
import { EditorLanguageProvider } from './i18n';

jest.mock('./SlidePreview', () => jest.fn());
jest.mock('./VideoPreview', () => jest.fn());
jest.mock('components/external-video-player', () => () => <div>external</div>);
const recording = { slides: [{ page: 1 }], events: [] };
const screen = { id: 'screen', kind: 'deskshare', url: '/screen.mp4' };
const both = { source: 'slides', available: true, slides_available: true, screen_available: true };
let root, container;
const render = async (props = {}) => {
  const state = { recording, current: both, screen, time: 25000, playing: false, rate: 1, seekVersion: 4, ...props };
  state.sources = previewContentSources(state.recording, state.current, state.screen, state.external);
  await act(async () => root.render(<EditorLanguageProvider><ContentPreviews {...state} /></EditorLanguageProvider>));
};
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  SlidePreview.mockImplementation(({ time }) => <div className="mock-slide" data-time={time}>slide</div>);
  VideoPreview.mockImplementation(({ time, playing, rate }) => <video data-time={time} data-playing={playing} data-rate={rate} />);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('both materials stay mounted and synchronized when the recording foreground changes', async () => {
  await render();
  const slide = container.querySelector('.mock-slide'), video = container.querySelector('video');
  expect(container.querySelectorAll('.re-content-candidate')).toHaveLength(2);
  expect(container.querySelector('[data-source="slides"]').dataset.selected).toBe('true');
  expect(container.querySelector('[data-source="screen"]').textContent).toContain('For comparison');
  await render({ current: { ...both, source: 'screen' }, time: 26000, playing: true, rate: 1.5 });
  expect(container.querySelector('.mock-slide')).toBe(slide); expect(container.querySelector('video')).toBe(video);
  expect(video.dataset.time).toBe('26000'); expect(slide.dataset.time).toBe('26000');
  expect(video.dataset.playing).toBe('true'); expect(video.dataset.rate).toBe('1.5');
  expect(container.querySelector('[data-source="screen"]').dataset.selected).toBe('true');
  expect(container.querySelector('[data-source="slides"]').dataset.selected).toBe('false');
});

test('a missing material is omitted instead of duplicating the available source', async () => {
  await render({ screen: null, current: { ...both, screen_available: false } });
  expect(container.querySelectorAll('.re-content-candidate')).toHaveLength(1);
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelector('.re-content-candidate-heading')).toBeNull();
  await render({ recording: { slides: [] }, current: { ...both, source: 'screen', slides_available: false } });
  expect(container.querySelectorAll('.re-content-candidate')).toHaveLength(1);
  expect(container.querySelector('.mock-slide')).toBeNull();
});

test('both comparison materials stay visible when an external video is the recorded source', async () => {
  await render({ current: { ...both, source: 'external' }, external: { url: '/external' }, primary: {} });
  expect(container.querySelectorAll('.re-content-candidate')).toHaveLength(3);
  expect(container.querySelector('[data-source="external"]').dataset.selected).toBe('true');
  expect(container.querySelector('.mock-slide')).not.toBeNull(); expect(container.querySelector('video')).not.toBeNull();
});

test('hidden recorded content still permits comparison without marking either material as used', async () => {
  await render({ current: { ...both, source: 'none' } });
  expect(container.querySelectorAll('.re-content-candidate')).toHaveLength(2);
  expect(container.querySelector('[data-selected="true"]')).toBeNull();
  expect(container.querySelector('.mock-slide')).not.toBeNull(); expect(container.querySelector('video')).not.toBeNull();
});

test('an unavailable recorded source has a placeholder alongside the usable comparison material', async () => {
  await render({ current: { ...both, available: false, slides_available: false } });
  expect(container.querySelectorAll('.re-content-candidate')).toHaveLength(2);
  expect(container.querySelector('[data-source="slides"] .re-placeholder')).not.toBeNull();
  expect(container.querySelector('video')).not.toBeNull();
});
