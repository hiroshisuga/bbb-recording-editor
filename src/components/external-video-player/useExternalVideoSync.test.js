import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { audioAdapter } from '../recording-editor/model';
import useExternalVideoSync from './useExternalVideoSync';

test('external preview follows the editor audio clock, seek, pause, rate and mute', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const audio = document.createElement('audio');
  let paused = false;
  Object.defineProperty(audio, 'paused', { get: () => paused });
  audio.currentTime = 12;
  audio.playbackRate = 1.5;
  audio.volume = 0.4;
  audio.muted = true;
  const primary = audioAdapter(audio, 120000);
  const getPrimary = () => primary;
  const videos = [{ timestamp: 0, clear: 120, url: 'https://example.com/video.mp4',
    events: [{ timestamp: 0, type: 'play', time: 30, rate: 2 }] }];
  const provider = { getCurrentTime: jest.fn(() => 0), seekTo: jest.fn() };
  const removed = jest.spyOn(audio, 'removeEventListener');
  let view;
  function Probe() {
    view = useExternalVideoSync(videos, getPrimary);
    return null;
  }
  try {
    await act(async () => { root.render(<Probe />); });
    view.playerRef.current = provider;
    await act(async () => { view.notify('ready'); });
    expect(view).toMatchObject({ video: videos[0], playing: true, playbackRate: 3, volume: 0.4, muted: true });
    expect(provider.seekTo).toHaveBeenLastCalledWith(54, 'seconds', true);

    await act(async () => { audio.volume = 0.25; audio.muted = false; audio.dispatchEvent(new Event('volumechange')); });
    expect(view).toMatchObject({ volume: 0.25, muted: false });
    await act(async () => { audio.muted = true; audio.dispatchEvent(new Event('volumechange')); });
    expect(view).toMatchObject({ volume: 0.25, muted: true });

    await act(async () => { audio.currentTime = 55; audio.dispatchEvent(new Event('seeked')); });
    expect(provider.seekTo).toHaveBeenLastCalledWith(140, 'seconds', true);

    await act(async () => { paused = true; audio.dispatchEvent(new Event('pause')); });
    expect(view.playing).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  expect(removed).toHaveBeenCalledWith('seeked', expect.any(Function));
  removed.mockRestore();
});
