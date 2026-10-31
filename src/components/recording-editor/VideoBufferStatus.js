import React, { useEffect, useRef, useState } from 'react';

import { useEditorI18n } from './i18n';

// Only the continuous range containing the current position can feed playback.
// A distant range cached by an earlier seek must not inflate the number.
function bufferedAhead(video, position) {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= position && position <= ranges.end(i)) return Math.max(0, ranges.end(i) - position);
  }
  return 0;
}

export default function VideoBufferStatus({ videoRef, clip, time, playing, attempt }) {
  const { t } = useEditorI18n();
  const latest = useRef({ clip, time, playing });
  const [sample, setSample] = useState(null);
  useEffect(() => { latest.current = { clip, time, playing }; }, [clip, time, playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let waiting = false;
    const update = event => {
      if (event?.type === 'waiting') waiting = true;
      if (['playing', 'canplay', 'emptied'].includes(event?.type)) waiting = false;
      const current = latest.current;
      const position = video.currentTime;
      const ready = video.readyState >= 1 && Number.isFinite(position);
      const origin = Math.max(0, Number(current.clip.start_pts) || 0);
      let target = origin + Math.max(0, (current.time - current.clip.start_ms) / 1000);
      if (Number.isFinite(video.duration) && video.duration >= origin) {
        target = Math.min(target, Math.max(origin, video.duration - 0.001));
      }
      const state = video.error ? 'error' : !ready ? 'loading' : video.seeking ? 'seeking'
        : video.ended ? 'ended' : !current.playing ? 'paused'
          : waiting || video.readyState < 3 ? 'waiting' : 'playing';
      const next = {
        ahead: ready ? bufferedAhead(video, position).toFixed(1) : null,
        // This is the media clock, not the last frame painted by the browser.
        drift: ready ? Math.round((target - position) * 10) / 10 : null,
        state,
      };
      setSample(previous => previous && previous.ahead === next.ahead && previous.drift === next.drift && previous.state === next.state ? previous : next);
    };
    const events = ['progress', 'waiting', 'canplay', 'playing', 'seeking', 'seeked', 'loadedmetadata', 'loadeddata', 'emptied', 'pause', 'play', 'ended', 'error'];
    events.forEach(name => video.addEventListener(name, update));
    const timer = setInterval(update, 500);
    update();
    return () => {
      clearInterval(timer);
      events.forEach(name => video.removeEventListener(name, update));
    };
  }, [videoRef, clip.url, attempt]);

  const drift = sample?.drift;
  const difference = drift == null ? t('videoClockUnknown') : Math.abs(drift) < 0.1 ? t('videoClockAligned')
    : t(drift > 0 ? 'videoClockBehind' : 'videoClockAhead', { seconds: Math.abs(drift).toFixed(1) });
  return <div className="re-video-buffer" role="group" aria-label={t('videoBufferDiagnostics')} title={t('videoBufferHint')} data-state={sample?.state || 'loading'}>
    <span>{t('videoBufferAhead', { seconds: sample?.ahead ?? '—' })}</span>
    <span>{difference}</span>
    <span>{t(`videoState_${sample?.state || 'loading'}`)}</span>
  </div>;
}
