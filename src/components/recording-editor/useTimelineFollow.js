import { useCallback, useEffect, useRef } from 'react';

// Follow playback in pages, leaving a 20% overlap with the previous view.
export default function useTimelineFollow(scrollRef, timelineRef, { time, duration, playing, zoom, recordingId }) {
  const suspended = useRef(false);
  const pointerDown = useRef(false);
  const target = useRef(null);
  const lastScrollLeft = useRef(0);
  const stopScrolling = useCallback(() => {
    const element = scrollRef.current;
    if (element && target.current !== null) {
      if (element.scrollTo) element.scrollTo({ left: element.scrollLeft, behavior: 'auto' });
    }
    target.current = null;
    lastScrollLeft.current = element?.scrollLeft || 0;
  }, [scrollRef]);
  const suspend = useCallback(() => {
    suspended.current = true;
    stopScrolling();
  }, [stopScrolling]);

  useEffect(() => {
    stopScrolling();
    suspended.current = false;
  }, [playing, recordingId, stopScrolling]);
  useEffect(() => { stopScrolling(); }, [zoom, stopScrolling]);
  useEffect(() => {
    const release = () => { pointerDown.current = false; };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    const timeline = timelineRef.current;
    if (!playing || suspended.current || pointerDown.current || !element || !timeline || duration <= 0) return;
    const width = element.clientWidth;
    const max = element.scrollWidth - width;
    if (width <= 0 || max <= 0 || timeline.offsetWidth <= 0) return;
    const point = Math.max(0, Math.min(duration, time)) / duration * timeline.offsetWidth;
    // Use the destination during animation so successive playback ticks don't
    // restart the same smooth scroll before it has reached its destination.
    const left = target.current ?? element.scrollLeft;
    lastScrollLeft.current = element.scrollLeft;
    let next = left;
    if (point < left || point > left + width) next = point - width * 0.1;
    else if (point >= left + width * 0.9) next = left + width * 0.8;
    next = Math.max(0, Math.min(max, next));
    if (Math.abs(next - left) < 1) return;
    target.current = next;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (element.scrollTo) element.scrollTo({ left: next, behavior: reducedMotion ? 'auto' : 'smooth' });
    else element.scrollLeft = next;
  }, [time, duration, playing, zoom, recordingId, scrollRef, timelineRef]);

  return {
    onPointerDownCapture: () => { pointerDown.current = true; suspend(); },
    onWheelCapture: event => {
      if (event.deltaX || (event.shiftKey && event.deltaY)) suspend();
    },
    onKeyDownCapture: event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) suspend();
    },
    onScroll: event => {
      const left = event.currentTarget.scrollLeft;
      if (target.current !== null) {
        if (Math.abs(left - target.current) < 1) target.current = null;
      } else if (Math.abs(left - lastScrollLeft.current) >= 1) suspended.current = true;
      lastScrollLeft.current = left;
    },
  };
}
