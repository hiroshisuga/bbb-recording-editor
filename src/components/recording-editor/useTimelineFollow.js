import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// Follow playback in pages, leaving a 20% overlap with the previous view.
export default function useTimelineFollow(scrollRef, timelineRef, { time, duration, playing, zoom, recordingId }) {
  const suspended = useRef(false);
  const pointerDown = useRef(null);
  const target = useRef(null);
  const lastScrollLeft = useRef(0);
  const previousView = useRef({ zoom, recordingId });
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
    if (pointerDown.current) pointerDown.current.dragged = true;
    stopScrolling();
  }, [stopScrolling]);

  useEffect(() => {
    stopScrolling();
    suspended.current = false;
  }, [playing, recordingId, stopScrolling]);
  // Read the resized timeline after React updates its width, before paint.
  // Zooming is navigation even while paused or follow is manually suspended.
  // Ordinary playback ticks and seeks must not repeatedly recenter the view.
  useLayoutEffect(() => {
    const previous = previousView.current;
    previousView.current = { zoom, recordingId };
    if (previous.zoom === zoom || previous.recordingId !== recordingId) return;
    stopScrolling();
    const element = scrollRef.current;
    const timeline = timelineRef.current;
    if (!element || !timeline || duration <= 0 || element.clientWidth <= 0) return;
    const point = Math.max(0, Math.min(duration, time)) / duration * timeline.offsetWidth;
    const max = Math.max(0, element.scrollWidth - element.clientWidth);
    const next = Math.max(0, Math.min(max, point - element.clientWidth / 2));
    // An immediate assignment also gives the paging effect the final position.
    // Record it so the resulting scroll event is not mistaken for user input.
    element.scrollLeft = next;
    lastScrollLeft.current = next;
  }, [zoom, recordingId, time, duration, scrollRef, timelineRef, stopScrolling]);
  useEffect(() => {
    const matches = event => pointerDown.current && (event.pointerId === undefined
      || pointerDown.current.id === undefined || event.pointerId === pointerDown.current.id);
    const move = event => {
      const pointer = pointerDown.current;
      if (matches(event) && !pointer.dragged && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 4) suspend();
    };
    const release = event => {
      if (!matches(event)) return;
      move(event);
      // A click is playback navigation, so it keeps (or resumes) following.
      // Only an actual drag or manual scroll suspends it until the next play.
      if (event.type === 'pointerup' && !pointerDown.current.dragged) suspended.current = false;
      pointerDown.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, [suspend]);

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
    showTime: value => {
      suspend();
      const element = scrollRef.current, timeline = timelineRef.current;
      if (!element || !timeline || duration <= 0) return;
      element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth,
        value / duration * timeline.offsetWidth - element.clientWidth / 2));
    },
    onPointerDownCapture: event => {
      if (event.button !== 0) return;
      pointerDown.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
      stopScrolling();
    },
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
      } else if (Math.abs(left - lastScrollLeft.current) >= 1) {
        suspended.current = true;
        if (pointerDown.current) pointerDown.current.dragged = true;
      }
      lastScrollLeft.current = left;
    },
  };
}
