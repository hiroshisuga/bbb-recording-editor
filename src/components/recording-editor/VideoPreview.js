import React, { useEffect, useRef, useState } from 'react';

import { useEditorI18n } from './i18n';
import VideoBufferStatus from './VideoBufferStatus';
import { createVideoTrace } from './videoTrace';

const SEEK_DRIFT_SECONDS = 1;
const SEEK_COOLDOWN_MS = 3000;
const SEEK_SETTLE_MS = 750;
const CORRECTION_WINDOW_MS = 30000;
const CORRECTION_WARNING_COUNT = 4;

export default function VideoPreview({ clip, time, playing, rate, seekVersion = 0 }) {
  const { t } = useEditorI18n();
  const ref = useRef(null);
  const desired = useRef({ clip, time, playing, rate, seekVersion });
  const synchronize = useRef(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [syncWarning, setSyncWarning] = useState(false);

  useEffect(() => {
    desired.current = { clip, time, playing, rate, seekVersion };
    synchronize.current?.();
  }, [clip, time, playing, rate, seekVersion]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return undefined;
    let alive = true;
    let failed = false;
    let pendingPlay = null;
    let appliedSeekVersion = desired.current.seekVersion;
    let positioned = false;
    let waiting = false;
    let correctionAfter = 0;
    let autoSeekInFlight = false;
    let corrections = [];
    let warned = false;
    const trace = createVideoTrace(video, () => ({ ...desired.current, waiting, correctionAfter, autoSeekInFlight }));
    setError('');
    setSyncWarning(false);
    // Muted playback must also be set on the media element, not just its markup.
    video.muted = true;
    const fail = cause => {
      if (!alive) return;
      failed = true;
      const name = cause?.name || (cause?.code ? `MediaError ${cause.code}` : 'MediaError');
      trace.log('playback-error', { name, message: cause?.message });
      setError([name, cause?.message].filter(Boolean).join(': '));
    };
    const sync = event => {
      const current = desired.current;
      if (!alive || !current.clip || video.readyState < 1 || failed) return;
      if (!current.playing) video.pause();
      let playbackRate = current.rate;
      // Raw WebM can keep a nonzero container timeline. Seeking to elapsed
      // seconds alone repeatedly seeks before its first frame and freezes it.
      const origin = Math.max(0, Number(current.clip.start_pts) || 0);
      let position = origin + Math.max(0, (current.time - current.clip.start_ms) / 1000);
      if (Number.isFinite(video.duration) && video.duration >= origin) {
        position = Math.min(position, Math.max(origin, video.duration - 0.001));
      }
      // Audio ticks keep the same version. Only a new user destination may
      // cancel an obsolete seek AND its pending raw-media network request.
      const requestedSeek = current.seekVersion !== appliedSeekVersion;
      appliedSeekVersion = current.seekVersion;
      const now = performance.now();
      const drift = position - video.currentTime;
      const precise = !positioned || requestedSeek || !current.playing;
      const preciseReason = requestedSeek ? 'user-seek' : !positioned ? 'initial-position' : 'paused-position';
      if (requestedSeek) trace.log('user-seek');
      if (requestedSeek || !current.playing) corrections = [];
      if (requestedSeek && video.seeking && Math.abs(drift) > 0.01) {
        // Only an explicit user seek may cancel an obsolete HTTP range.
        pendingPlay = null;
        positioned = false;
        autoSeekInFlight = false;
        trace.log('reload-request', { reason: 'cancel-obsolete-user-seek', toS: position });
        try { video.load(); trace.log('reload-applied'); } catch (cause) { fail(cause); }
        return;
      }
      if (event?.type === 'seeked') {
        // The audio clock may have advanced while fetching the target. Give
        // decoding/playback time to recover instead of immediately seeking again.
        correctionAfter = Math.max(correctionAfter, now + (autoSeekInFlight ? SEEK_COOLDOWN_MS : SEEK_SETTLE_MS));
        autoSeekInFlight = false;
      }
      if (!video.seeking) {
        if (precise) {
          positioned = true;
          correctionAfter = now + SEEK_SETTLE_MS;
          if (Math.abs(drift) > 0.01) {
            trace.log('seek-request', { reason: preciseReason, toS: position });
            try { video.currentTime = position; } catch (cause) { fail(cause); return; }
            trace.log('seek-assigned', { reason: preciseReason, toS: position });
          }
        } else if (!waiting && video.readyState >= 3 && now >= correctionAfter) {
          if (Math.abs(drift) > SEEK_DRIFT_SECONDS) {
            // Never chase the moving audio target while seeking/buffering.
            // The cooldown starts again on completion if this fetch is slow.
            correctionAfter = now + SEEK_COOLDOWN_MS;
            autoSeekInFlight = true;
            trace.log('seek-request', { reason: 'automatic-drift', toS: position });
            try { video.currentTime = position; } catch (cause) { fail(cause); return; }
            trace.log('seek-assigned', { reason: 'automatic-drift', toS: position });
            corrections = corrections.filter(at => now - at <= CORRECTION_WINDOW_MS);
            corrections.push(now);
            if (!warned && current.clip.kind === 'deskshare' && corrections.length >= CORRECTION_WARNING_COUNT) {
              warned = true;
              setSyncWarning(true);
            }
          } else if (Math.abs(drift) > 0.15) {
            // Only the muted video changes speed; the master audio is untouched.
            playbackRate = current.rate * (drift > 0 ? 1.05 : 0.95);
          }
        }
      }
      if (video.playbackRate !== playbackRate) video.playbackRate = playbackRate;
      if (current.playing && video.paused && !pendingPlay) {
        const token = {};
        pendingPlay = token;
        try {
          Promise.resolve(video.play()).catch(cause => {
            // Pausing, replacing the source, and unmounting can abort play.
            if (pendingPlay === token && cause?.name !== 'AbortError' && desired.current.playing) fail(cause);
          }).finally(() => { if (pendingPlay === token) pendingPlay = null; });
        } catch (cause) { pendingPlay = null; fail(cause); }
      }
    };
    const mediaError = () => { if (video.error) fail(video.error); };
    const bufferWaiting = () => { waiting = true; video.playbackRate = desired.current.rate; };
    const bufferReady = event => { waiting = false; sync(event); };
    const events = ['loadedmetadata', 'loadeddata', 'seeked'];
    events.forEach(name => video.addEventListener(name, sync));
    video.addEventListener('error', mediaError);
    video.addEventListener('waiting', bufferWaiting);
    video.addEventListener('canplay', bufferReady);
    video.addEventListener('playing', bufferReady);
    synchronize.current = sync;
    sync();
    return () => {
      trace.close();
      alive = false;
      if (synchronize.current === sync) synchronize.current = null;
      events.forEach(name => video.removeEventListener(name, sync));
      video.removeEventListener('error', mediaError);
      video.removeEventListener('waiting', bufferWaiting);
      video.removeEventListener('canplay', bufferReady);
      video.removeEventListener('playing', bufferReady);
      video.pause();
    };
  }, [clip?.url, attempt]);

  if (!clip) return <div className="re-placeholder">{t('noVideo')}</div>;
  return <div className="re-video">
    <video ref={ref} key={`${clip.url}:${attempt}`} src={clip.url} muted playsInline preload="auto" />
    <span>{clip.kind === 'deskshare' ? t('screen') : clip.user || t('camera')}</span>
    {clip.kind === 'deskshare' && !error && <VideoBufferStatus videoRef={ref} clip={clip} time={time} playing={playing} attempt={attempt} />}
    {syncWarning && !error && <p className="re-render-warning" role="status">{t('videoSyncWarning')} <button onClick={() => setSyncWarning(false)}>{t('videoSyncDismiss')}</button></p>}
    {error && <p className="re-render-warning" role="alert">{t('videoError', { file: clip.relative })} {error} <button onClick={() => setAttempt(value => value + 1)}>{t('videoRetry')}</button></p>}
  </div>;
}
