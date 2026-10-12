import { useEffect, useState } from 'react';

export default function useExternalVideoTitles(videos, recordingId, loadTitle) {
  const [result, setResult] = useState({ recordingId: null, titles: {} });
  useEffect(() => {
    let cancelled = false;
    setResult({ recordingId, titles: {} });
    // Deduplicate repeated shares and fetch one at a time without blocking the editor.
    const urls = [...new Set(videos.filter(video => !video.title?.trim() && video.url).map(video => video.url))];
    async function load() {
      for (const url of urls) {
        if (cancelled) break;
        try {
          const { title } = await loadTitle(recordingId, url);
          if (!cancelled && typeof title === 'string' && title.trim()) {
            setResult(current => ({ recordingId, titles: { ...current.titles, [url]: title.trim() } }));
          }
        } catch { /* Keep the URL visible when metadata is unavailable. */ }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [videos, recordingId, loadTitle]);
  return result.recordingId === recordingId ? result.titles : {};
}
