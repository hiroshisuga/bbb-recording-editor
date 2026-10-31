import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import RecordingEditor from './index';
import { LANGUAGE_KEY } from './i18n';
import useAudioPreview from './useAudioPreview';
import VideoPreview from './VideoPreview';
import { PREFERENCES_KEY, readPreferences } from './preferences';

jest.mock('./SlidePreview', () => () => <div>slide preview</div>);
jest.mock('./VideoPreview', () => jest.fn(() => <div>video preview</div>));
jest.mock('./useAudioPreview', () => jest.fn());
jest.mock('components/external-video-player', () => () => <div>external preview</div>);

const id = `${'a'.repeat(40)}-1700000000000`;
const manifest = {
  id, name: '編集テスト', revision: 'revision-one', duration_ms: 60000,
  record_ranges: [{ start_ms: 1000, end_ms: 59000 }], beep_ranges: [], record_ranges_persisted: true,
  events: [], assets: [], slides: [], warnings: [], published_url: '/playback/test',
  rebuild: { available: true, status: 'not_requested' },
  reset: { available: true },
};
let container;
let root;
let calls;
const originalFetch = global.fetch;
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent === text);
async function click(text) { await act(async () => { Simulate.click(button(text)); }); }
async function time(label, text) {
  const input = container.querySelector(`input[aria-label="${label}"]`);
  await act(async () => { Simulate.change(input, { target: { value: text } }); });
  await act(async () => { Simulate.blur(input); });
}
async function selectRange() {
  const [start, end] = container.querySelectorAll('.re-selection input');
  await time(end.getAttribute('aria-label'), '00:00:03.000');
  await time(start.getAttribute('aria-label'), '00:00:01.000');
}
async function language(value) {
  await act(async () => { Simulate.change(container.querySelector('.re-language select'), { target: { value } }); });
}
async function volume(value) {
  await act(async () => Simulate.change(container.querySelector('.re-volume input'), { target: { value: String(value) } }));
}
async function timelineClick(target, clientX, { shiftKey = true, clickShiftKey = shiftKey, button = 0 } = {}) {
  await act(async () => {
    ['pointerdown', 'pointerup', 'click'].forEach(type => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button,
        detail: 1, shiftKey: type === 'click' ? clickShiftKey : shiftKey });
      Object.assign(event, { pointerId: 1 });
      target.dispatchEvent(event);
    });
  });
}

beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.spyOn(navigator, 'language', 'get').mockReturnValue('ja-JP');
  localStorage.removeItem(LANGUAGE_KEY);
  localStorage.removeItem(PREFERENCES_KEY);
  calls = [];
  global.fetch = jest.fn(async (url, options) => {
    const payload = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url, payload, headers: options?.headers });
    let result;
    if (url.endsWith('/recordings')) result = [{ id, name: manifest.name, date: '2026-10-10T08:00:00Z', duration_ms: 60000,
      recorded_duration_ms: 58000, recording_status: 'marked', publication_status: 'unpublished', raw_available: true, warnings: [] }];
    else if (url.endsWith('/preview')) result = { status: 'done', result: { audio_url: '/demo.webm', peaks: [0.1, 0.5] } };
    else if (url.endsWith('/draft')) result = payload;
    else if (url.endsWith('/rebuild')) result = { status: 'done', result: { available: true, status: 'requested' } };
    else if (url.endsWith('/save')) result = { status: 'done', result: { xml_backup: '/backup/events.xml' } };
    else if (url.endsWith('/reset')) result = { status: 'done', result: { archive: '/history/reset' } };
    else result = manifest;
    return { ok: true, json: async () => result };
  });
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<RecordingEditor />); });
  await act(async () => { Simulate.click(container.querySelector('.re-meeting')); });
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.removeItem(LANGUAGE_KEY); localStorage.removeItem(PREFERENCES_KEY); jest.restoreAllMocks(); global.fetch = originalFetch; });

test('published recording link is shown only when the manifest has a public playback URL', async () => {
  const link = container.querySelector('.re-title a');
  expect(link.getAttribute('href')).toBe('/playback/test');
  expect(link.target).toBe('_blank');
  const fetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => url.endsWith(`/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, published_url: null }) }
    : fetch(url, options));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  expect(container.querySelector('.re-title a')).toBeNull();
  await language('en');
  expect(container.textContent).not.toContain('Published recording');
  global.fetch.mockImplementation(fetch);
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  expect(container.querySelector('.re-title a').textContent).toBe('Published recording ↗');
});

test('opening and reopening begin unselected and allow entering the start time first', async () => {
  expect(container.querySelector('.re-selection-overlay')).toBeNull();
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:00.000');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:00.000');
  expect(button('ピー音を追加').disabled).toBe(true);
  expect(button('録画に残す').disabled).toBe(true);
  expect(button('録画から除外').disabled).toBe(true);
  await time('選択開始', '00:00:06.500');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:06.500');
  expect(container.querySelector('.re-selection-overlay')).toBeNull();
  expect(button('ピー音を追加').disabled).toBe(true);
  await time('選択終了', '00:00:09.500');
  expect(container.querySelector('.re-selection-overlay')).not.toBeNull();
  expect(button('ピー音を追加').disabled).toBe(false);
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  expect(container.querySelector('.re-selection-overlay')).toBeNull();
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:00.000');
  expect(button('ピー音を追加').disabled).toBe(true);
  expect(button('rawデータへ保存…').disabled).toBe(true);
});

test('shift-click selects from the playhead to the beginning before excluding the selection', async () => {
  const timeline = container.querySelector('.re-timeline');
  timeline.getBoundingClientRect = () => ({ left: 100, width: 600 });
  const audio = container.querySelector('audio');
  audio.currentTime = 15;
  await act(async () => audio.dispatchEvent(new Event('seeked')));
  await timelineClick(container.querySelector('.re-wave'), 100);
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:00.000');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:15.000');
  expect(audio.currentTime).toBe(15);
  expect(button('↶ 元に戻す').disabled).toBe(true);
  expect(button('rawデータへ保存…').disabled).toBe(true);
  await click('録画から除外');
  expect(container.querySelector('[aria-label="録画に残す区間1 開始"]').value).toBe('00:00:15.000');
  expect(button('↶ 元に戻す').disabled).toBe(false);
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
});

test('shift-click on a ribbon selects forward while playback continues without seeking', async () => {
  const timeline = container.querySelector('.re-timeline');
  timeline.getBoundingClientRect = () => ({ left: 100, width: 600 });
  const audio = container.querySelector('audio');
  Object.defineProperties(audio, { paused: { value: false }, ended: { value: false } });
  audio.currentTime = 20.123;
  await act(async () => audio.dispatchEvent(new Event('play')));
  HTMLMediaElement.prototype.pause.mockClear();
  // Releasing Shift before the click must not activate the ribbon's own click.
  await timelineClick(container.querySelector('.re-bar span'), 555, { clickShiftKey: false });
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:20.123');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:45.500');
  expect(audio.currentTime).toBe(20.123);
  expect(audio.paused).toBe(false);
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  expect(button('↶ 元に戻す').disabled).toBe(true);
  // Normal ribbon clicks still select that entire existing interval.
  await timelineClick(container.querySelector('.re-bar'), 200, { shiftKey: false });
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:01.000');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:59.000');
});

test('shift-click uses the zoomed and scrolled timeline coordinates before adding a keep interval', async () => {
  const fetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => url.endsWith(`/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, record_ranges: [], record_ranges_persisted: false }) }
    : fetch(url, options));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  await act(async () => Simulate.change(container.querySelector('.re-tools select'), { target: { value: '4' } }));
  const timeline = container.querySelector('.re-timeline');
  timeline.getBoundingClientRect = () => ({ left: -900, width: 2400 });
  const audio = container.querySelector('audio');
  audio.currentTime = 5;
  await act(async () => audio.dispatchEvent(new Event('seeked')));
  await timelineClick(container.querySelector('.re-wave'), 500);
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:05.000');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:35.000');
  expect(audio.currentTime).toBe(5);
  expect(container.querySelector('.re-bar')).toBeNull();
  await click('録画に残す');
  expect(container.querySelector('[aria-label="録画に残す区間1 開始"]').value).toBe('00:00:05.000');
  expect(container.querySelector('[aria-label="録画に残す区間1 終了"]').value).toBe('00:00:35.000');
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
});

test('shift-clicking the playhead leaves an empty selection', async () => {
  const timeline = container.querySelector('.re-timeline');
  timeline.getBoundingClientRect = () => ({ left: 100, width: 600 });
  const audio = container.querySelector('audio');
  audio.currentTime = 15;
  await act(async () => audio.dispatchEvent(new Event('seeked')));
  await timelineClick(timeline, 250);
  expect(container.querySelector('.re-selection-overlay')).toBeNull();
  expect(button('録画に残す').disabled).toBe(true);
  expect(button('録画から除外').disabled).toBe(true);
  expect(audio.currentTime).toBe(15);
});

test.each([
  ['開始を現在位置に', 200, '終了を現在位置に', 300],
  ['終了を現在位置に', 300, '開始を現在位置に', 200],
])('timeline clicks preserve the boundary set by %s until the other boundary is set', async (first, firstX, second, secondX) => {
  const timeline = container.querySelector('.re-timeline');
  timeline.getBoundingClientRect = () => ({ left: 100, width: 600 });
  timeline.setPointerCapture = jest.fn();
  const wave = container.querySelector('.re-wave');
  const audio = container.querySelector('audio');
  await timelineClick(wave, firstX, { shiftKey: false });
  expect(audio.currentTime).toBe((firstX - 100) / 10);
  await click(first);
  const boundary = [...container.querySelectorAll('.re-selection input')].map(input => input.value);
  await timelineClick(wave, secondX, { shiftKey: false });
  expect(audio.currentTime).toBe((secondX - 100) / 10);
  expect([...container.querySelectorAll('.re-selection input')].map(input => input.value)).toEqual(boundary);
  await click(second);
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:10.000');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:20.000');
  expect(container.querySelector('.re-selection-overlay')).not.toBeNull();
  expect(button('rawデータへ保存…').disabled).toBe(true);
  await click('録画から除外');
  expect(container.querySelector('[aria-label="録画に残す区間1 終了"]').value).toBe('00:00:10.000');
  expect(container.querySelector('[aria-label="録画に残す区間2 開始"]').value).toBe('00:00:20.000');
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
});

test('ordinary clicks preserve an existing selection while dragging replaces it', async () => {
  const timeline = container.querySelector('.re-timeline');
  timeline.getBoundingClientRect = () => ({ left: 100, width: 600 });
  timeline.setPointerCapture = jest.fn();
  await time('選択開始', '00:00:10.000');
  await time('選択終了', '00:00:20.000');
  await timelineClick(container.querySelector('.re-wave'), 400, { shiftKey: false });
  expect(container.querySelector('audio').currentTime).toBe(30);
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:10.000');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:20.000');
  await act(async () => {
    [['pointerdown', 400], ['pointermove', 200], ['pointerup', 200]].forEach(([type, clientX]) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
      Object.assign(event, { pointerId: 2 });
      timeline.dispatchEvent(event);
    });
  });
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:10.000');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:30.000');
  expect(container.querySelector('audio').currentTime).toBe(10);
  expect(button('rawデータへ保存…').disabled).toBe(true);
});

test('editing, undo/redo and draft send meeting-time ranges with revision', async () => {
  await time('選択開始', '00:00:06.500');
  await time('選択終了', '00:00:09.500');
  await click('ピー音を追加');
  expect(container.querySelector('[aria-label="ピー音で置き換える区間1 開始"]').value).toBe('00:00:06.500');
  await click('↶ 元に戻す');
  expect(container.querySelector('[aria-label="ピー音で置き換える区間1 開始"]')).toBeNull();
  await click('↷ やり直す');
  await click('下書きを保存');
  const draft = calls.find(c => c.url.endsWith('/draft'));
  expect(draft.payload).toMatchObject({ revision: 'revision-one', beep_ranges: [{ start_ms: 6500, end_ms: 9500 }] });
  expect(draft.headers['X-BBB-Editor']).toBe('1');
  expect(calls.some(c => c.url.endsWith('/save'))).toBe(false);
});

test('volume and mute affect preview playback without changing edits or saving raw data', async () => {
  const audio = container.querySelector('audio');
  expect(audio.volume).toBe(1);
  await volume(35);
  expect(audio.volume).toBeCloseTo(0.35);
  expect(container.querySelector('.re-volume output').textContent).toBe('35%');
  await click('ミュート');
  expect(audio.muted).toBe(true);
  expect(audio.volume).toBeCloseTo(0.35);
  expect(button('ミュート解除').getAttribute('aria-pressed')).toBe('true');
  await click('ミュート解除');
  expect(audio.muted).toBe(false);
  expect(audio.volume).toBeCloseTo(0.35);
  await volume(0);
  expect(audio.volume).toBe(0);
  await click('ミュート解除');
  expect(audio.volume).toBeCloseTo(0.35);
  await click('ミュート');
  await volume(60);
  expect(audio.muted).toBe(false);
  expect(audio.volume).toBeCloseTo(0.6);
  expect(button('rawデータへ保存…').disabled).toBe(true);
  expect(button('↶ 元に戻す').disabled).toBe(true);
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
  await language('en');
  expect(container.querySelector('input[aria-label="Volume"]').value).toBe('60');
  expect(button('Mute').getAttribute('aria-pressed')).toBe('false');
});

test('reopening media preserves volume and mute settings', async () => {
  await volume(25);
  await click('ミュート');
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  expect(container.querySelector('audio').volume).toBeCloseTo(0.25);
  expect(container.querySelector('audio').muted).toBe(true);
  expect(container.querySelector('.re-volume input').value).toBe('25');
});

test('external video ribbons show titles and sharing intervals with only interior update markers', async () => {
  const previousFetch = global.fetch;
  const events = [
    { type: 'SharePresentationEvent', time_ms: 0, presentation: 'Slides' },
    { type: 'GotoSlideEvent', time_ms: 500, page: 1 },
    { type: 'StartExternalVideoRecordEvent', time_ms: 1000, url: 'https://example.com/one', title: 'Recorded <title>' },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 1000, status: 'play' },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 2000, status: 'playbackRateChange', rate: '2', position: '20' },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 3000, status: 'pause', state: '0' },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 4000, status: 'seek', position: '45' },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 4500, status: 'play' },
    { type: 'UpdateExternalVideoRecordEvent', time_ms: 5000, status: 'pause' },
    { type: 'StopExternalVideoRecordEvent', time_ms: 5000 },
    { type: 'StartExternalVideoRecordEvent', time_ms: 30000, url: 'https://youtu.be/test-video' },
  ];
  global.fetch = jest.fn(async (url, options) => {
    if (url.endsWith('/external-video-title')) {
      expect(JSON.parse(options.body)).toEqual({ url: 'https://youtu.be/test-video' });
      return { ok: true, json: async () => ({ title: 'Fetched title' }) };
    }
    if (url.endsWith(`/recordings/${id}`)) return { ok: true, json: async () => ({ ...manifest, events }) };
    return previousFetch(url, options);
  });
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  const ribbons = container.querySelectorAll('.re-external-ribbon');
  expect([...ribbons].map(ribbon => ribbon.textContent)).toEqual(['Recorded <title>', 'Fetched title']);
  expect(ribbons[0].querySelector('title')).toBeNull();
  expect(parseFloat(ribbons[0].style.left)).toBeCloseTo(100 / 60);
  expect(parseFloat(ribbons[0].style.width)).toBeCloseTo(400 / 60);
  expect(ribbons[1].style.left).toBe('50%');
  expect(ribbons[1].style.width).toBe('50%');
  const markers = container.querySelectorAll('.re-external-marker');
  expect(markers).toHaveLength(4);
  expect(markers[0].dataset.tooltip).toContain('再生速度変更 · 2×');
  expect(markers[0].dataset.tooltip).toContain('動画内の位置 00:00:20.000');
  expect(markers[1].dataset.tooltip).toContain('一時停止');
  expect(markers[2].dataset.tooltip).toContain('シーク');
  expect(container.querySelectorAll('.re-slide-track .re-event-marker')).toHaveLength(1);
  await act(async () => Simulate.click(markers[2]));
  expect(container.querySelector('audio').currentTime).toBe(4);
  await act(async () => Simulate.click(ribbons[0]));
  expect(container.querySelector('audio').currentTime).toBe(1);
  await language('en');
  expect(markers[0].dataset.tooltip).toContain('Playback speed change');
  expect(container.querySelector('.re-external-track .re-track-label').textContent).toBe('External video');
  expect(button('Save to raw…').disabled).toBe(true);
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
});

test('presentation ribbons group slides by deck with interior navigation and camera markers', async () => {
  const previousFetch = global.fetch;
  const events = [
    { type: 'SharePresentationEvent', time_ms: 1000, presentation: 'Deck <A>' },
    { type: 'GotoSlideEvent', time_ms: 1000, presentation: 'Deck <A>', page: 1 },
    { type: 'SharePresentationEvent', time_ms: 3000, presentation: 'Deck <A>' },
    { type: 'GotoSlideEvent', time_ms: 4000, presentation: 'Deck <A>', page: 2 },
    { type: 'ResizeAndMoveSlideEvent', time_ms: 5000 },
    { type: 'StartExternalVideoRecordEvent', time_ms: 6000, url: 'https://example.com/video.mp4', title: 'Video' },
    { type: 'StopExternalVideoRecordEvent', time_ms: 7000 },
    { type: 'GotoSlideEvent', time_ms: 8500, presentation: 'Deck <A>', page: 3 },
    { type: 'SharePresentationEvent', time_ms: 10000, presentation: 'Deck B' },
    { type: 'GotoSlideEvent', time_ms: 12000, presentation: 'Deck B', page: 2 },
    { type: 'SharePresentationEvent', time_ms: 20000, presentation: 'Deck <A>' },
    { type: 'GotoSlideEvent', time_ms: 22000, presentation: 'Deck <A>', page: 4 },
    { type: 'SharePresentationEvent', time_ms: 25000, presentation: 'Deck <A>', share: 'false' },
    { type: 'SharePresentationEvent', time_ms: 30000, presentation: 'Deck <A>' },
    { type: 'GotoSlideEvent', time_ms: 35000, presentation: 'Deck <A>', page: 5 },
  ].map(event => ({ ...event, presentation_filename: event.presentation === 'Deck <A>' ? '講義 <A>.pptx' : event.presentation === 'Deck B' ? 'Second.pdf' : undefined }));
  global.fetch = jest.fn(async (url, options) => url.endsWith(`/recordings/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, events }) } : previousFetch(url, options));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  const ribbons = container.querySelectorAll('.re-presentation-ribbon');
  expect([...ribbons].map(ribbon => ribbon.textContent)).toEqual(['講義 <A>.pptx', 'Second.pdf', '講義 <A>.pptx', '講義 <A>.pptx']);
  expect(ribbons[0].dataset.tooltip).toBe('講義 <A>.pptx\n00:00:01.000 – 00:00:10.000');
  expect(parseFloat(ribbons[0].style.width)).toBe(15);
  expect(ribbons[2].dataset.tooltip).toContain('00:00:20.000 – 00:00:25.000');
  expect(ribbons[3].style.left).toBe('50%');
  expect(ribbons[3].style.width).toBe('50%');
  expect(ribbons[0].querySelector('a')).toBeNull();
  const markers = container.querySelectorAll('.re-presentation-marker');
  expect(markers).toHaveLength(6);
  expect(markers[0].dataset.tooltip).toContain('スライド 2');
  expect(markers[1].dataset.tooltip).toContain('パン／ズーム');
  await act(async () => Simulate.click(markers[5]));
  expect(container.querySelector('audio').currentTime).toBe(35);
  await act(async () => Simulate.click(ribbons[2]));
  expect(container.querySelector('audio').currentTime).toBe(20);
  await language('en');
  expect(markers[1].dataset.tooltip).toContain('Slide pan / zoom');
  expect(button('Save to raw…').disabled).toBe(true);
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
});

test('default presentation styling uses the recorded filename and applies to its interior markers', async () => {
  const previousFetch = global.fetch;
  const events = [
    { type: 'SharePresentationEvent', time_ms: 0, presentation: 'id-default', presentation_filename: 'default.pdf' },
    { type: 'GotoSlideEvent', time_ms: 5000, presentation: 'id-default', page: 2 },
    { type: 'SharePresentationEvent', time_ms: 10000, presentation: 'id-lecture', presentation_filename: 'Lecture.pdf' },
    { type: 'GotoSlideEvent', time_ms: 15000, presentation: 'id-lecture', page: 2 },
    { type: 'SharePresentationEvent', time_ms: 20000, presentation: 'id-default-again', presentation_filename: 'DEFAULT.PDF' },
    { type: 'GotoSlideEvent', time_ms: 25000, presentation: 'id-default-again', page: 2 },
  ];
  global.fetch = jest.fn(async (url, options) => url.endsWith(`/recordings/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, events }) } : previousFetch(url, options));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  const isDefault = element => element.classList.contains('re-default-presentation');
  expect([...container.querySelectorAll('.re-presentation-ribbon')].map(isDefault)).toEqual([true, false, true]);
  const markers = container.querySelectorAll('.re-presentation-marker');
  expect([...markers].map(isDefault)).toEqual([true, false, true]);
  await act(async () => Simulate.click(markers[0]));
  expect(container.querySelector('audio').currentTime).toBe(5);
  expect(button('rawデータへ保存…').disabled).toBe(true);
});

test('audio playback pages the zoomed timeline without seeking or saving edits', async () => {
  await act(async () => Simulate.change(container.querySelector('.re-tools select'), { target: { value: '4' } }));
  const scroll = container.querySelector('.re-timeline-scroll');
  Object.defineProperties(scroll, { clientWidth: { value: 300 }, scrollWidth: { value: 1200 } });
  Object.defineProperty(container.querySelector('.re-timeline'), 'offsetWidth', { value: 1200 });
  scroll.scrollTo = jest.fn();
  const audio = container.querySelector('audio');
  Object.defineProperties(audio, { paused: { configurable: true, value: false }, ended: { value: false } });
  audio.currentTime = 13.5;
  await act(async () => audio.dispatchEvent(new Event('play')));
  expect(scroll.scrollTo).toHaveBeenLastCalledWith({ left: 240, behavior: 'smooth' });
  expect(audio.currentTime).toBe(13.5);
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
  Object.defineProperty(audio, 'paused', { value: true });
  await act(async () => audio.dispatchEvent(new Event('pause')));
  scroll.scrollTo.mockClear();
  audio.currentTime = 30;
  await act(async () => audio.dispatchEvent(new Event('seeked')));
  expect(scroll.scrollTo).not.toHaveBeenCalled();
});

test('clicking a later time during playback continues timeline paging without pause/play', async () => {
  await act(async () => Simulate.change(container.querySelector('.re-tools select'), { target: { value: '4' } }));
  const scroll = container.querySelector('.re-timeline-scroll');
  const timeline = container.querySelector('.re-timeline');
  Object.defineProperties(scroll, { clientWidth: { value: 300 }, scrollWidth: { value: 1200 } });
  Object.defineProperty(timeline, 'offsetWidth', { value: 1200 });
  timeline.getBoundingClientRect = () => ({ left: 0, width: 1200 });
  timeline.setPointerCapture = jest.fn();
  scroll.scrollTo = jest.fn();
  const audio = container.querySelector('audio');
  Object.defineProperties(audio, { paused: { value: false }, ended: { value: false } });
  audio.currentTime = 5;
  await act(async () => audio.dispatchEvent(new Event('play')));
  expect(scroll.scrollTo).not.toHaveBeenCalled();
  await act(async () => Simulate.pointerDown(timeline, { button: 0, clientX: 285, clientY: 100, pointerId: 1 }));
  const up = new Event('pointerup', { bubbles: true });
  Object.assign(up, { clientX: 285, clientY: 100, pointerId: 1 });
  await act(async () => timeline.dispatchEvent(up));
  expect(audio.currentTime).toBe(14.25);
  expect(scroll.scrollTo).toHaveBeenLastCalledWith({ left: 240, behavior: 'smooth' });
  audio.currentTime = 30;
  await act(async () => audio.dispatchEvent(new Event('seeked')));
  expect(scroll.scrollTo).toHaveBeenLastCalledWith({ left: 570, behavior: 'smooth' });
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
});

test('reopening restores saved beep intervals without changing the beep preview preference', async () => {
  const beeps = [{ start_ms: 6500, end_ms: 9500 }];
  const checkbox = container.querySelector('.re-transport input[type="checkbox"]');
  await act(async () => { Simulate.change(checkbox, { target: { checked: false } }); });
  global.fetch.mockImplementation(async url => ({ ok: true, json: async () => url.endsWith('/preview')
    ? { status: 'done', result: { audio_url: '/demo.webm', peaks: [] } } : { ...manifest, beep_ranges: beeps } }));
  await act(async () => { Simulate.click(container.querySelector('.re-meeting')); });
  expect(container.querySelector('[aria-label="ピー音で置き換える区間1 開始"]').value).toBe('00:00:06.500');
  expect(container.querySelector('.re-transport input[type="checkbox"]').checked).toBe(false);
  expect(useAudioPreview).toHaveBeenLastCalledWith(expect.anything(), beeps, false);
});

test('language, volume, mute, beep preview, speed and zoom survive reopening the editor', async () => {
  await volume(37);
  await click('ミュート');
  await act(async () => {
    Simulate.change(container.querySelector('.re-transport input[type="checkbox"]'), { target: { checked: false } });
    Simulate.change(container.querySelector('.re-transport select'), { target: { value: '1.5' } });
    Simulate.change(container.querySelector('.re-tools select'), { target: { value: '8' } });
  });
  await language('en');
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<RecordingEditor />));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  expect(container.querySelector('.re-language select').value).toBe('en');
  expect(container.querySelector('.re-volume input').value).toBe('37');
  expect(container.querySelector('.re-transport input[type="checkbox"]').checked).toBe(false);
  expect(container.querySelector('.re-transport select').value).toBe('1.5');
  expect(container.querySelector('.re-tools select').value).toBe('8');
  const audio = container.querySelector('audio');
  expect(audio.volume).toBeCloseTo(0.37);
  expect(audio.muted).toBe(true);
  expect(audio.playbackRate).toBe(1.5);
  expect(audio.paused).toBe(true);
  expect(readPreferences()).toEqual({ volume: 0.37, muted: true, lastVolume: 0.37, beepPreview: false, rate: 1.5, zoom: 8, detailWaveOpen: false, detailWaveSpan: 10000 });
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
});

test('unmuting from zero after reopening restores the remembered nonzero volume', async () => {
  await volume(37);
  await volume(0);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<RecordingEditor />));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  expect(container.querySelector('audio').volume).toBe(0);
  await click('ミュート解除');
  expect(container.querySelector('audio').volume).toBeCloseTo(0.37);
});

test('resetting a recording preserves listening preferences', async () => {
  await volume(25);
  await click('ミュート');
  await act(async () => Simulate.change(container.querySelector('.re-transport input[type="checkbox"]'), { target: { checked: false } }));
  await click('初期状態に戻す…');
  await click('確認して初期状態に戻す');
  expect(container.querySelector('audio').volume).toBeCloseTo(0.25);
  expect(container.querySelector('audio').muted).toBe(true);
  expect(container.querySelector('.re-transport input[type="checkbox"]').checked).toBe(false);
});

test('preferences remain editable when browser storage is blocked', async () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<RecordingEditor />));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  await volume(20);
  await act(async () => Simulate.change(container.querySelector('.re-transport input[type="checkbox"]'), { target: { checked: false } }));
  expect(container.querySelector('audio').volume).toBeCloseTo(0.2);
  expect(container.querySelector('.re-transport input[type="checkbox"]').checked).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('reset requires confirmation and clears edits, draft and undo without rebuilding', async () => {
  await selectRange();
  await click('ピー音を追加');
  await click('初期状態に戻す…');
  expect(calls.some(call => call.url.endsWith('/reset'))).toBe(false);
  expect(container.querySelector('.re-reset-review').textContent).toContain('履歴へ退避');
  await click('確認して初期状態に戻す');
  expect(calls.find(call => call.url.endsWith('/reset')).payload).toEqual({ revision: 'revision-one', confirmed: true });
  expect(container.querySelector('[aria-label="ピー音で置き換える区間1 開始"]')).toBeNull();
  expect(button('↶ 元に戻す').disabled).toBe(true);
  expect(container.querySelector('.re-selection-overlay')).toBeNull();
  expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:00.000');
  expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:00.000');
  expect(button('ピー音を追加').disabled).toBe(true);
  expect(container.textContent).toContain('初期状態をrawデータに復元しました');
  expect(button('rawデータへ保存…').disabled).toBe(true);
  expect(button('録画を再構築…').disabled).toBe(false);
  expect(calls.filter(call => call.url.endsWith('/preview'))).toHaveLength(2);
  expect(calls.some(call => call.url.endsWith('/rebuild'))).toBe(false);
});

test('reset with an unavailable helper explains setup without requiring another raw save', async () => {
  const fetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => url.endsWith(`/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, last_operation: 'reset', playback_sync: 'needs_rebuild', rebuild: { available: false, status: 'not_requested' } }) }
    : fetch(url, options));
  await click('初期状態に戻す…');
  await click('確認して初期状態に戻す');
  expect(button('rawデータへ保存…').disabled).toBe(true);
  expect(button('録画を再構築…').disabled).toBe(true);
  expect(container.textContent).toContain('rawデータへの再保存は不要');
  expect(container.querySelector('#re-rebuild-reason').textContent).toContain('rawデータへの保存や初期化とは別の条件');
  expect(calls.some(call => call.url.endsWith('/save'))).toBe(false);
});

test('unmarked meetings open with no keep intervals and require an explicit interval before saving', async () => {
  const fetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => url.endsWith(`/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, record_ranges: [], record_ranges_persisted: false }) }
    : fetch(url, options));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  expect(container.querySelector('.re-bar')).toBeNull();
  expect(container.querySelector('.re-selection-overlay')).toBeNull();
  expect(button('rawデータへ保存…').disabled).toBe(true);
  expect(button('rawデータへ保存…').title).toContain('区間を1つ以上指定');
  expect(button('録画を再構築…').disabled).toBe(true);
  expect(container.querySelector('#re-rebuild-reason').textContent).toContain('区間を1つ以上指定');
  expect(calls.some(call => call.url.endsWith('/save'))).toBe(false);
  await selectRange();
  await click('録画に残す');
  expect(button('rawデータへ保存…').disabled).toBe(false);
  expect(button('録画を再構築…').disabled).toBe(true);
  await click('rawデータへ保存…');
  await click('バックアップを作成して保存');
  expect(calls.find(call => call.url.endsWith('/save')).payload.record_ranges).toEqual([{ start_ms: 1000, end_ms: 3000 }]);
});

test('resetting an unmarked original restores empty keep intervals', async () => {
  const fetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => url.endsWith(`/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, record_ranges: [], record_ranges_persisted: false, last_operation: 'reset', playback_sync: 'needs_rebuild' }) }
    : fetch(url, options));
  await click('初期状態に戻す…');
  await click('確認して初期状態に戻す');
  expect(container.querySelector('.re-bar')).toBeNull();
  expect(button('rawデータへ保存…').disabled).toBe(true);
  expect(button('録画を再構築…').disabled).toBe(true);
  expect(container.querySelector('#re-rebuild-reason').textContent).toContain('区間を1つ以上指定');
  expect(container.textContent).toContain('録画に残す区間は空');
  expect(container.textContent).not.toContain('現在の編集内容はrawデータに保存済み');
  expect(calls.some(call => call.url.endsWith('/save'))).toBe(false);
});

test('BBB processing blocks mutations and explains the disabled rebuild', async () => {
  const fetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => url.endsWith(`/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, rebuild: { available: true, status: 'not_requested', processing: true } }) }
    : fetch(url, options));
  await act(async () => { Simulate.click(container.querySelector('.re-meeting')); });
  await selectRange();
  await click('ピー音を追加');
  expect(button('rawデータへ保存…').disabled).toBe(true);
  expect(button('録画を再構築…').disabled).toBe(true);
  expect(button('初期状態に戻す…').disabled).toBe(true);
  expect(container.querySelector('#re-rebuild-reason').textContent).toContain('処理中');
});

test('record-off splits the range and bad time input cannot edit it', async () => {
  await time('選択開始', '00:00:06.500');
  await time('選択終了', '00:00:09.500');
  await click('録画から除外');
  await time('録画に残す区間1 開始', '00:61:00');
  expect(container.querySelector('[aria-label="録画に残す区間1 開始"]').classList.contains('invalid')).toBe(true);
  await click('下書きを保存');
  expect(calls.find(c => c.url.endsWith('/draft')).payload.record_ranges).toEqual([
    { start_ms: 1000, end_ms: 6500 }, { start_ms: 9500, end_ms: 59000 },
  ]);
});

test('saving refreshes meeting summaries and keeps the current publication badge', async () => {
  await selectRange();
  await click('ピー音を追加');
  await click('rawデータへ保存…');
  await click('バックアップを作成して保存');
  expect(calls.filter(call => call.url.endsWith('/recordings'))).toHaveLength(2);
  expect(container.querySelector('.re-meeting .re-status-unpublished').textContent).toBe('非公開');
  expect(container.textContent).toContain('XMLバックアップ: /backup/events.xml');
});

test('switching language preserves edits, selection, filter, undo history and media', async () => {
  await time('選択開始', '00:00:06.500');
  await time('選択終了', '00:00:09.500');
  await click('ピー音を追加');
  await act(async () => { Simulate.change(container.querySelector('[aria-label="会議の絞り込み"]'), { target: { value: 'unpublished' } }); });
  const requests = calls.length;
  const audio = container.querySelector('audio');
  await language('en');
  expect(container.querySelector('.re-brand').textContent).toBe('BigBlueButton');
  expect(document.title).toBe('BigBlueButton · Recording editor');
  expect(document.documentElement.lang).toBe('en');
  expect(container.querySelector('.re-header strong').textContent).toBe('Recording editor');
  expect(container.querySelector('[aria-label="Selection start"]').value).toBe('00:00:06.500');
  expect(container.querySelector('[aria-label="Intervals to replace with beeps 1 start"]').value).toBe('00:00:06.500');
  expect(container.querySelector('[aria-label="Filter meetings"]').value).toBe('unpublished');
  expect(container.querySelector('.re-status-unpublished').textContent).toBe('Unpublished');
  expect(container.querySelector('.re-dirty').textContent).toBe('Unsaved changes');
  expect(container.querySelector('audio')).toBe(audio);
  expect(calls).toHaveLength(requests);
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  await click('↶ Undo');
  expect(container.querySelector('[aria-label="Intervals to replace with beeps 1 start"]')).toBeNull();
  await click('↷ Redo');
  await click('Save draft');
  expect(container.textContent).toContain('Draft saved. Raw data has not been changed.');
  expect(calls.find(c => c.url.endsWith('/draft')).payload.beep_ranges).toEqual([{ start_ms: 6500, end_ms: 9500 }]);
  await language('ja');
  expect(container.textContent).toContain('下書きを保存しました。rawデータは変更していません。');
  expect(container.querySelector('[aria-label="ピー音で置き換える区間1 開始"]').value).toBe('00:00:06.500');
});

test('warnings, save review, errors and completed messages follow the selected language', async () => {
  const warned = { ...manifest, warnings: ['rawデータがありません。'],
    events: [{ type: 'PublicChatEvent', time_ms: 0, name: '参加者', message: 'rawデータがありません。' }] };
  global.fetch.mockImplementation(async url => ({ ok: true, json: async () => url.endsWith('/preview')
    ? { status: 'done', result: { audio_url: '/demo.webm', peaks: [] } } : warned }));
  await act(async () => { Simulate.click(container.querySelector('.re-meeting')); });
  await language('en');
  expect(container.querySelector('.re-warnings').textContent).toContain('Raw data is missing.');
  // User content is kept exactly as recorded, even when it resembles a diagnostic.
  expect(container.querySelector('.re-events').textContent).toContain('参加者: rawデータがありません。');
  await selectRange();
  await click('Add beep');
  await click('Save to raw…');
  expect(container.querySelector('.re-review').textContent).toContain('Keep: 1 interval / Beep: 1 interval');
  global.fetch.mockImplementation(async () => ({ ok: false, json: async () => ({ error: 'events.xmlが変更されています。会議を読み直してください。' }) }));
  await click('Back up and save');
  expect(container.querySelector('[role="alert"]').textContent).toBe('events.xml has changed. Reload the meeting.');
  await language('ja');
  expect(container.querySelector('[role="alert"]').textContent).toBe('events.xmlが変更されています。会議を読み直してください。');
});


test('raw review explains audio file changes before sending a save request', async () => {
  await selectRange();
  await click('ピー音を追加');
  await click('rawデータへ保存…');
  const review = container.querySelector('.re-review');
  expect(review.textContent).toContain('rawデータ内に別名ファイルを追加してXMLの参照先を切り替えます');
  expect(review.textContent).toContain('元ファイルとバックアップは保持します');
  expect(calls.some(call => call.url.endsWith('/save'))).toBe(false);
  await language('en');
  expect(review.textContent).toContain('All microphone audio and screen-sharing audio');
  expect(review.textContent).toContain('Original files and backups are retained');
});

test('rebuild requires saved edits and a separate confirmation, then reports a request not completion', async () => {
  await selectRange();
  await click('ピー音を追加');
  expect(button('録画を再構築…').disabled).toBe(true);
  await click('↶ 元に戻す');
  await click('録画を再構築…');
  expect(calls.some(call => call.url.endsWith('/rebuild'))).toBe(false);
  const review = container.querySelector('.re-rebuild-review');
  expect(review.textContent).toContain('削除され、作り直されます');
  expect(review.textContent).toContain('非公開状態の維持は保証されません');
  await language('en');
  expect(review.textContent).toContain('Unsaved edits and drafts are not included');
  await click('Confirm and request rebuild');
  const rebuild = calls.find(call => call.url.endsWith('/rebuild'));
  expect(rebuild.payload).toEqual({ revision: 'revision-one', confirmed: true });
  expect(rebuild.headers['X-BBB-Editor']).toBe('1');
  expect(container.textContent).toContain('It is not complete yet');
  expect(button('Rebuild recording…').disabled).toBe(true);
  expect(button('Save to raw…').disabled).toBe(true);
  expect(calls.some(call => call.url.endsWith('/save'))).toBe(false);
});

test('rebuild helper absence is visible and prevents submitting a request', async () => {
  global.fetch.mockImplementation(async url => ({ ok: true, json: async () => url.endsWith('/preview')
    ? { status: 'done', result: { audio_url: '/demo.webm', peaks: [] } }
    : { ...manifest, rebuild: { available: false, status: 'not_requested' } } }));
  await act(async () => { Simulate.click(container.querySelector('.re-meeting')); });
  expect(button('録画を再構築…').disabled).toBe(true);
  expect(container.querySelector('#re-rebuild-reason').textContent).toContain('未設置');
  expect(container.querySelector('#re-rebuild-reason code').textContent).toBe('sudo bash editor/deploy/install-rebuild-helper.sh');
});

test('polling a completed rebuild updates the message and unlocks raw saving', async () => {
  jest.useFakeTimers();
  try {
    await click('録画を再構築…');
    await click('確認して再構築を依頼');
    const originalMock = global.fetch.getMockImplementation();
    global.fetch.mockImplementation(async (url, options) => !options?.method && url.endsWith('/rebuild')
      ? { ok: true, json: async () => ({ available: true, status: 'completed' }) }
      : originalMock(url, options));
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(container.querySelector('.re-success').textContent).toContain('録画の再構築が完了しました');
    expect(button('rawデータへ保存…').disabled).toBe(true);
    expect(button('録画を再構築…').disabled).toBe(false);
    await selectRange();
    await click('ピー音を追加');
    expect(button('rawデータへ保存…').disabled).toBe(false);
  } finally { jest.useRealTimers(); }
});

test('detailed waveform is opt-in, shares selection with beep editing, and saves its display preferences', async () => {
  const previous = global.fetch.getMockImplementation();
  const detailedUrl = `/recording-editor/api/recordings/${id}/preview/${'a'.repeat(24)}/audio.webm`;
  global.fetch.mockImplementation(async (url, options) => {
    if (url.endsWith('/preview')) return { ok: true, json: async () => ({ status: 'done', result: { audio_url: detailedUrl, peaks: [] } }) };
    if (url.includes('/waveform/')) return { ok: true, json: async () => ({ start_ms: Number(url.split('/').pop()) * 10000,
      step_ms: 10, min: [-0.2], max: [0.4] }) };
    return previous(url, options);
  });
  try {
    await act(async () => Simulate.click(container.querySelector('.re-meeting')));
    await act(async () => new Promise(resolve => setTimeout(resolve, 180)));
    expect(global.fetch.mock.calls.some(([url]) => url.includes('/waveform/'))).toBe(false);
    await click('詳細波形を表示');
    await act(async () => new Promise(resolve => setTimeout(resolve, 180)));
    expect(global.fetch.mock.calls.filter(([url]) => url.includes('/waveform/'))).toHaveLength(1);
    const plot = container.querySelector('.re-detail-plot');
    plot.getBoundingClientRect = () => ({ left: 0, width: 500 });
    plot.setPointerCapture = jest.fn();
    await act(async () => {
      Simulate.pointerDown(plot, { button: 0, clientX: 50, pointerId: 1 });
      Simulate.pointerMove(plot, { clientX: 100, pointerId: 1 });
      Simulate.pointerUp(plot, { clientX: 100, pointerId: 1 });
    });
    expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:01.000');
    expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:02.000');
    expect(container.querySelector('.re-selection-overlay')).not.toBeNull();
    await click('ピー音を追加');
    expect(container.querySelector('[aria-label="ピー音で置き換える区間1 開始"]').value).toBe('00:00:01.000');
    expect(container.querySelector('.re-detail-record-range').style.left).toBe('10%');
    await click('録画から除外');
    expect(container.querySelector('.re-detail-record-range').style.left).toBe('20%');
    expect(container.querySelector('.re-detail-record-range').dataset.tooltip).toContain('00:00:02.000 – 00:00:59.000');
    await click('録画に残す');
    expect(container.querySelector('.re-detail-record-range').style.left).toBe('10%');
    expect(global.fetch.mock.calls.filter(([url]) => url.includes('/waveform/'))).toHaveLength(1);
    expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
    await act(async () => Simulate.change(container.querySelector('.re-detail-tools select'), { target: { value: '5000' } }));
    expect(readPreferences()).toEqual(expect.objectContaining({ detailWaveOpen: true, detailWaveSpan: 5000 }));
    await click('詳細波形を閉じる');
    expect(container.querySelector('.re-detail-wave')).toBeNull();
  } finally { global.fetch.mockImplementation(previous); }
});

test('changing timeline zoom centers the paused playhead and preserves playback and selection', async () => {
  await selectRange();
  const timeline = container.querySelector('.re-timeline');
  const scroller = container.querySelector('.re-timeline-scroll');
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(timeline, 'offsetWidth', { configurable: true, get: () => parseFloat(timeline.style.width) * 10 });
  Object.defineProperty(scroller, 'scrollWidth', { configurable: true, get: () => timeline.offsetWidth });
  const audio = container.querySelector('audio');
  audio.currentTime = 30;
  await act(async () => audio.dispatchEvent(new Event('seeked')));
  expect(audio.paused).toBe(true);
  expect(scroller.scrollLeft).toBe(0);
  const before = calls.length;
  for (const [zoom, left] of [[4, 1500], [8, 3500], [2, 500], [1, 0]]) {
    await act(async () => Simulate.change(container.querySelector('.re-tools select'), { target: { value: String(zoom) } }));
    expect(scroller.scrollLeft).toBe(left);
    expect(audio.currentTime).toBe(30);
    expect(audio.paused).toBe(true);
    expect(container.querySelector('[aria-label="選択開始"]').value).toBe('00:00:01.000');
    expect(container.querySelector('[aria-label="選択終了"]').value).toBe('00:00:03.000');
  }
  expect(button('rawデータへ保存…').disabled).toBe(true);
  expect(calls).toHaveLength(before);
});

test('editor navigation identifies new seeks for both screen sharing and webcams, but audio ticks do not', async () => {
  const previous = global.fetch.getMockImplementation();
  const assets = ['deskshare', 'video'].map(kind => ({ id: kind, kind, has_video: true, start_ms: 0, end_ms: 60000, url: `/${kind}.webm` }));
  global.fetch.mockImplementation(async (url, options) => url.endsWith(`/${id}`)
    ? { ok: true, json: async () => ({ ...manifest, assets }) } : previous(url, options));
  await act(async () => Simulate.click(container.querySelector('.re-meeting')));
  const latest = kind => VideoPreview.mock.calls.filter(([props]) => props.clip.kind === kind).slice(-1)[0][0];
  const first = latest('deskshare').seekVersion;
  expect(latest('video').seekVersion).toBe(first);
  await time('再生位置', '00:00:20.000');
  for (const kind of ['deskshare', 'video']) {
    expect(latest(kind)).toEqual(expect.objectContaining({ time: 20000, seekVersion: first + 1 }));
  }
  const audio = container.querySelector('audio');
  audio.currentTime = 20.1;
  await act(async () => audio.dispatchEvent(new Event('seeked')));
  for (const kind of ['deskshare', 'video']) {
    expect(latest(kind)).toEqual(expect.objectContaining({ time: 20100, seekVersion: first + 1 }));
  }
  await time('再生位置', '00:00:05.000');
  for (const kind of ['deskshare', 'video']) {
    expect(latest(kind)).toEqual(expect.objectContaining({ time: 5000, seekVersion: first + 2 }));
  }
  expect(button('rawデータへ保存…').disabled).toBe(true);
  expect(calls.some(call => /\/(save|draft|reset)$/.test(call.url))).toBe(false);
});
