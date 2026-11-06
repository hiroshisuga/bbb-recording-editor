import { useLayoutEffect } from 'react';

// Both panes use the same viewport and zoom. Mirror only changed positions so
// the scroll event echoed by the browser cannot interrupt automatic following.
export default function useTimelineScrollSync(audioRef, tracksRef, zoom) {
  useLayoutEffect(() => {
    const audio = audioRef.current, tracks = tracksRef.current;
    if (!audio || !tracks) return undefined;
    const mirror = (source, target) => {
      if (Math.abs(source.scrollLeft - target.scrollLeft) > 0.5) target.scrollLeft = source.scrollLeft;
    };
    const fromAudio = () => mirror(audio, tracks);
    const fromTracks = () => mirror(tracks, audio);
    fromAudio();
    audio.addEventListener('scroll', fromAudio);
    tracks.addEventListener('scroll', fromTracks);
    return () => {
      audio.removeEventListener('scroll', fromAudio);
      tracks.removeEventListener('scroll', fromTracks);
    };
  }, [audioRef, tracksRef, zoom]);
}
