import React from 'react';
import ReactPlayer from 'react-player';
import { useEditorI18n } from '../recording-editor/i18n';
import useExternalVideoSync from './useExternalVideoSync';
import './styles.css';

const config = {
  youtube: { playerVars: { autoplay: 0, controls: 1, enablejsapi: 1, rel: 0 } },
  file: { attributes: { playsInline: true } },
};

export default function ExternalVideoPlayer({ videos, getPrimary }) {
  const { t } = useEditorI18n();
  const { video, playing, playbackRate, volume, muted, autoPlayBlocked, error,
    playerRef, notify } = useExternalVideoSync(videos, getPrimary);
  if (!video) return null;
  return (
    <div className="externalVideos-wrapper">
      {(autoPlayBlocked || error) && (
        <p className="autoPlayWarning" role="status">
          {error ? t('externalVideoError', { code: error }) : t('externalVideoAutoPlayWarning')}
        </p>
      )}
      <ReactPlayer
        key={`${video.timestamp}:${video.clear}:${video.url}`}
        ref={playerRef}
        url={video.url}
        config={config}
        controls
        playsinline
        volume={volume}
        muted={muted}
        playing={playing}
        playbackRate={playbackRate}
        onReady={() => notify('ready')}
        onPlay={() => notify('play')}
        onPause={() => notify('pause')}
        onEnded={() => notify('ended')}
        onBuffer={() => notify('buffer')}
        onBufferEnd={() => notify('bufferEnd')}
        onError={error => notify('error', error)}
        width="100%"
        height="100%"
      />
    </div>
  );
}
