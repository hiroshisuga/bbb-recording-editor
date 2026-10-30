import React, { useEffect, useRef, useState } from 'react';

import { useEditorI18n } from './i18n';

export default function VideoPreview({ clip, time, playing, rate }) {
  const { t } = useEditorI18n();
  const ref = useRef(null);
  const desired = useRef({ clip, time, playing, rate });
  const synchronize = useRef(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    desired.current = { clip, time, playing, rate };
    synchronize.current?.();
  }, [clip, time, playing, rate]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return undefined;
    let alive = true;
    let failed = false;
    let pendingPlay = null;
    setError('');
    // Muted playback must also be set on the media element, not just its markup.
    video.muted = true;
    const fail = cause => {
      if (!alive) return;
      failed = true;
      const name = cause?.name || (cause?.code ? `MediaError ${cause.code}` : 'MediaError');
      setError([name, cause?.message].filter(Boolean).join(': '));
    };
    const sync = () => {
      const current = desired.current;
      if (!alive || !current.clip || video.readyState < 1 || failed) return;
      if (!current.playing) video.pause();
      video.playbackRate = current.rate;
      // Raw WebM can keep a nonzero container timeline. Seeking to elapsed
      // seconds alone repeatedly seeks before its first frame and freezes it.
      const origin = Math.max(0, Number(current.clip.start_pts) || 0);
      let position = origin + Math.max(0, (current.time - current.clip.start_ms) / 1000);
      if (Number.isFinite(video.duration) && video.duration >= origin) {
        position = Math.min(position, Math.max(origin, video.duration - 0.001));
      }
      // Let the current seek finish, then apply the latest requested position.
      // Replacing it on every 100ms audio tick can starve slow raw-video seeks.
      if (!video.seeking && Math.abs(video.currentTime - position) > (current.playing ? 0.2 : 0.01)) {
        try { video.currentTime = position; } catch (cause) { fail(cause); return; }
      }
      if (current.playing && video.paused && !pendingPlay) {
        const token = {};
        pendingPlay = token;
        try {
          Promise.resolve(video.play()).catch(cause => {
            // Pausing, replacing the source, and unmounting can abort play.
            if (cause?.name !== 'AbortError' && desired.current.playing) fail(cause);
          }).finally(() => { if (pendingPlay === token) pendingPlay = null; });
        } catch (cause) { pendingPlay = null; fail(cause); }
      }
    };
    const mediaError = () => fail(video.error);
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked'];
    events.forEach(name => video.addEventListener(name, sync));
    video.addEventListener('error', mediaError);
    synchronize.current = sync;
    sync();
    return () => {
      alive = false;
      if (synchronize.current === sync) synchronize.current = null;
      events.forEach(name => video.removeEventListener(name, sync));
      video.removeEventListener('error', mediaError);
      video.pause();
    };
  }, [clip?.url, attempt]);

  if (!clip) return <div className="re-placeholder">{t('noVideo')}</div>;
  return <div className="re-video">
    <video ref={ref} key={`${clip.url}:${attempt}`} src={clip.url} muted playsInline preload="auto" />
    <span>{clip.kind === 'deskshare' ? t('screen') : clip.user || t('camera')}</span>
    {error && <p className="re-render-warning" role="alert">{t('videoError', { file: clip.relative })} {error} <button onClick={() => setAttempt(value => value + 1)}>{t('videoRetry')}</button></p>}
  </div>;
}
