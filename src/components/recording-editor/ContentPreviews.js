import React from 'react';
import ExternalVideoPlayer from 'components/external-video-player';
import SlidePreview from './SlidePreview';
import VideoPreview from './VideoPreview';
import { useEditorI18n } from './i18n';

export function previewContentSources(recording, current, screen, external) {
  const sources = [];
  if (current?.slides_available ?? recording.slides.length > 0) sources.push('slides');
  if (screen) sources.push('screen');
  if (current?.source === 'external' && external) sources.push('external');
  if (current?.source && current.source !== 'none' && !sources.includes(current.source)) sources.push(current.source);
  return sources.length ? sources : ['none'];
}

export default function ContentPreviews({ recording, current, screen, external, sources, time, playing, rate, seekVersion, videos, primary, getPrimary }) {
  const { t } = useEditorI18n();
  const slidesAvailable = current?.slides_available ?? recording.slides.length > 0;
  const labels = sources.length > 1 || sources[0] !== current?.source;
  return <div className={`re-content-previews${sources.length > 1 ? ' re-content-previews--compare' : ''}`}>
    {sources.map(source => {
      const selected = source === current?.source;
      const role = t(selected ? 'contentSelected' : 'contentReference');
      return <section key={source} className={`re-content-candidate${selected ? ' re-content-candidate--selected' : ''}`}
        data-source={source} data-selected={selected} role="group" aria-label={`${t(`content_${source}`)} · ${role}`}>
        {labels && <div className="re-content-candidate-heading"><strong>{t(`content_${source}`)}</strong><span>{role}</span></div>}
        <div className="re-content-candidate-body">{source === 'slides' && slidesAvailable ? <SlidePreview recording={recording} time={time} />
          : source === 'screen' && screen ? <VideoPreview clip={screen} time={time} playing={playing} rate={rate} seekVersion={seekVersion} />
          : source === 'external' && external && primary ? <ExternalVideoPlayer videos={videos} getPrimary={getPrimary} />
          : <div className="re-placeholder">{t(source === 'none' ? 'contentHidden' : 'contentUnavailable')}</div>}</div>
      </section>;
    })}
  </div>;
}
