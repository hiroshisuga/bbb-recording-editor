import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import useAudioPreview from './useAudioPreview';

const originalAudioContext = window.AudioContext;
const node = () => ({ connect: jest.fn(other => other), disconnect: jest.fn() });
const gain = () => ({ ...node(), gain: {
  cancelScheduledValues: jest.fn(), setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn(),
} });
let root, container, audio, context;
const ranges = [{ start_ms: 1000, end_ms: 4000 }];
function Probe() { useAudioPreview(audio, ranges, true); return null; }
async function changed() {
  await act(async () => audio.dispatchEvent(new Event('volumechange')));
}

beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  const source = node();
  const oscillator = { ...node(), frequency: { value: 0 }, start: jest.fn(), stop: jest.fn() };
  context = { currentTime: 10, destination: {}, gains: [], source, oscillator,
    createMediaElementSource: jest.fn(() => source),
    createGain: jest.fn(() => { const result = gain(); context.gains.push(result); return result; }),
    createOscillator: jest.fn(() => oscillator), resume: jest.fn(async () => {}), close: jest.fn(async () => {}),
  };
  window.AudioContext = jest.fn(() => context);
  audio = document.createElement('audio');
  Object.defineProperties(audio, { paused: { value: false }, ended: { value: false }, readyState: { value: 3 } });
  audio.currentTime = 2;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  jest.clearAllTimers(); jest.useRealTimers(); window.AudioContext = originalAudioContext;
});

test('generated beep volume follows the media volume and mute cancels audible beep scheduling', async () => {
  const tone = context.gains[1].gain;
  audio.volume = 0.35;
  await changed();
  expect(tone.linearRampToValueAtTime).toHaveBeenCalledWith(0.12 * 0.35, expect.any(Number));
  tone.linearRampToValueAtTime.mockClear();
  audio.muted = true;
  await changed();
  expect(tone.cancelScheduledValues).toHaveBeenLastCalledWith(10);
  expect(tone.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
  expect(tone.linearRampToValueAtTime).not.toHaveBeenCalled();
  audio.muted = false;
  await changed();
  expect(tone.linearRampToValueAtTime).toHaveBeenCalledWith(0.12 * 0.35, expect.any(Number));
});

test('zero volume silences generated beeps and changing volume reschedules them', async () => {
  const tone = context.gains[1].gain;
  tone.linearRampToValueAtTime.mockClear();
  audio.volume = 0;
  await changed();
  expect(tone.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
  expect(tone.linearRampToValueAtTime).not.toHaveBeenCalled();
  audio.volume = 0.8;
  await changed();
  expect(tone.linearRampToValueAtTime).toHaveBeenCalledWith(0.12 * 0.8, expect.any(Number));
  expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
});
