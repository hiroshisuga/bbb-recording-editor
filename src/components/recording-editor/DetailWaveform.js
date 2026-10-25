import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorI18n } from './i18n';
import { formatTime } from './model';

export const CHUNK_MS = 10000;
const clamp = (value, max) => Math.max(0, Math.min(max, value));
const windowStart = (time, duration, span) => clamp(Math.round(time - span / 2), Math.max(0, duration - span));
export function chunkIndexes(start, span, duration) {
  const end = Math.min(duration, start + span);
  if (end <= start) return [];
  return Array.from({ length: Math.floor((end - 1) / CHUNK_MS) - Math.floor(start / CHUNK_MS) + 1 },
    (_, i) => Math.floor(start / CHUNK_MS) + i);
}

// Fetch only visible tiles, followed by at most one speculative neighbor. The
// effect is keyed to the view, not playback ticks. Aborting a superseded view
// prevents stale results and discards its remaining queue on rapid seeks.
export function useWaveformTiles(audioUrl, start, span, duration, prefetch, retry) {
  const cache = useRef(new Map());
  const [tiles, setTiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const indexes = chunkIndexes(start, span, duration);
    const identity = index => `${audioUrl}:${index}`;
    const cached = () => indexes.map(i => cache.current.get(identity(i))).filter(Boolean);
    setTiles(cached()); setError(false);
    if (!audioUrl) { setLoading(false); return () => controller.abort(); }
    const load = async index => {
      const key = identity(index);
      if (cache.current.has(key)) return cache.current.get(key);
      let response;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        response = await fetch(audioUrl.replace(/\/audio\.webm$/, `/waveform/${index}`), { signal });
        if (response.ok) break;
        if (![429, 503].includes(response.status) || attempt === 3) throw new Error('waveform');
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
        if (signal.aborted) return null;
      }
      const tile = await response.json();
      if (signal.aborted) return null;
      if (tile.start_ms !== index * CHUNK_MS || tile.step_ms !== 10 || !Array.isArray(tile.min)
        || !Array.isArray(tile.max) || tile.min.length !== tile.max.length || tile.min.length > 1000
        || !tile.min.every(Number.isFinite) || !tile.max.every(Number.isFinite)) throw new Error('waveform');
      cache.current.set(key, tile);
      // Bound browser memory even during hours of continuous playback.
      while (cache.current.size > 36) cache.current.delete(cache.current.keys().next().value);
      return tile;
    };
    const run = async () => {
      setLoading(cached().length < indexes.length);
      try {
        for (const index of indexes) {
          await load(index);
          if (signal.aborted) return;
          setTiles(cached());
        }
        setLoading(false);
        const next = indexes[indexes.length - 1] + 1;
        if (prefetch && next * CHUNK_MS < duration) await load(next);
      } catch (e) {
        if (signal.aborted) return;
        // Speculative failure must not hide an already complete view.
        if (cached().length < indexes.length) { setError(true); setLoading(false); }
      }
    };
    // Cache hits display immediately; defer new work to coalesce rapid seeks.
    const timer = setTimeout(run, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [audioUrl, start, span, duration, prefetch, retry]);
  return { tiles, loading, error };
}

function WaveCanvas({ tiles, start, span, label }) {
  const canvas = useRef(null);
  useEffect(() => {
    const element = canvas.current;
    const draw = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      element.width = width * ratio; element.height = height * ratio;
      const context = element.getContext('2d');
      context.scale(ratio, ratio);
      context.strokeStyle = getComputedStyle(element).color;
      context.globalAlpha = 0.25;
      context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
      context.globalAlpha = 1;
      // Aggregate into screen pixels. There are no per-sample DOM nodes and
      // this canvas never redraws just because the playhead has advanced.
      const low = new Float32Array(width).fill(Infinity);
      const high = new Float32Array(width).fill(-Infinity);
      tiles.forEach(tile => tile.min.forEach((value, i) => {
        const a = (tile.start_ms + i * tile.step_ms - start) / span * width;
        const b = a + tile.step_ms / span * width;
        for (let x = Math.max(0, Math.floor(a)); x < Math.min(width, Math.ceil(b)); x += 1) {
          low[x] = Math.min(low[x], value); high[x] = Math.max(high[x], tile.max[i]);
        }
      }));
      context.beginPath();
      for (let x = 0; x < width; x += 1) {
        if (!Number.isFinite(low[x])) continue;
        context.moveTo(x + 0.5, height / 2 - Math.max(-1, Math.min(1, high[x])) * height * 0.46);
        context.lineTo(x + 0.5, height / 2 - Math.max(-1, Math.min(1, low[x])) * height * 0.46);
      }
      context.stroke();
    };
    draw();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [tiles, start, span]);
  return <canvas ref={canvas} aria-label={label} role="img" />;
}

export default function DetailWaveform({ audioUrl, duration, time, playing, selection, setSelection, seek, span, setSpan }) {
  const { t } = useEditorI18n();
  const width = Math.min(span, duration || span);
  const [start, setStart] = useState(() => windowStart(time, duration, width));
  const [dragging, setDragging] = useState(false);
  const [retry, setRetry] = useState(0);
  const pointer = useRef(null);
  const previousSpan = useRef(width);
  useEffect(() => {
    if (dragging) return;
    if (previousSpan.current !== width || time < start || time > start + width) {
      setStart(windowStart(time, duration, width));
    } else if (playing && time >= start + width * 0.9) {
      setStart(clamp(Math.round(time - width * 0.1), Math.max(0, duration - width)));
    }
    previousSpan.current = width;
  }, [time, playing, width, duration, start, dragging]);
  const { tiles, loading, error } = useWaveformTiles(audioUrl, start, width, duration,
    playing && !dragging && time >= start + width * 0.65, retry);
  const ticks = useMemo(() => [0, 0.5, 1].map(p => formatTime(start + width * p)), [start, width]);
  const pct = value => `${clamp((value - start) / width * 100, 100)}%`;
  const position = e => {
    const bounds = e.currentTarget.getBoundingClientRect();
    return Math.round(start + clamp((e.clientX - bounds.left) / bounds.width, 1) * width);
  };
  const down = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const value = position(e);
    if (e.shiftKey) {
      setSelection({ start_ms: Math.round(Math.min(time, value)), end_ms: Math.round(Math.max(time, value)) });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = { start: value, x: e.clientX, moved: false };
    setDragging(true);
  };
  const move = e => {
    if (!pointer.current) return;
    const p = pointer.current;
    if (!p.moved && Math.abs(e.clientX - p.x) < 4) return;
    p.moved = true;
    const value = position(e);
    setSelection({ start_ms: Math.min(p.start, value), end_ms: Math.max(p.start, value) });
  };
  const release = e => {
    if (!pointer.current) return;
    move(e); seek(position(e)); pointer.current = null; setDragging(false);
  };
  const cancel = () => { pointer.current = null; setDragging(false); };
  return <section className="re-detail-wave" aria-label={t('detailWave')}>
    <div className="re-detail-tools"><strong>{t('detailWave')}</strong><label>{t('detailSpan')} <select aria-label={t('detailSpan')} value={span} onChange={e => setSpan(Number(e.target.value))}>
      {[5000, 10000, 30000].map(ms => <option key={ms} value={ms}>{t('detailSeconds', { seconds: ms / 1000 })}</option>)}
    </select></label><span className="re-muted">{t('detailHint')}</span></div>
    <div className="re-detail-ruler">{ticks.map((tick, i) => <span key={i}>{tick}</span>)}</div>
    <div className="re-detail-plot" onPointerDown={down} onPointerMove={move} onPointerUp={release} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <WaveCanvas tiles={tiles} start={start} span={width} label={t('detailWave')} />
      {selection.end_ms > selection.start_ms && selection.end_ms > start && selection.start_ms < start + width
        && <div className="re-detail-selection" style={{ left: pct(selection.start_ms), right: `${100 - clamp((selection.end_ms - start) / width * 100, 100)}%` }} />}
      {time >= start && time <= start + width && <div className="re-detail-playhead" style={{ left: pct(time) }} />}
      {loading && <span className="re-detail-status" role="status">{t('detailLoading')}</span>}
      {error && <span className="re-detail-status" role="status">{t('detailError')} <button onClick={() => setRetry(n => n + 1)} onPointerDown={e => e.stopPropagation()}>{t('detailRetry')}</button></span>}
    </div>
  </section>;
}
