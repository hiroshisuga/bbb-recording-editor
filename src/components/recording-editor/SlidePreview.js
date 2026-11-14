import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tldraw, AssetRecordType } from '@bigbluebutton/tldraw';
import '@bigbluebutton/tldraw/tldraw.css';
import { createTldrawImageAsset, createTldrawBackgroundShape } from './tldraw';
import { createSlideTimeline } from './slideTimeline';
import { useEditorI18n } from './i18n';

const EMPTY_STATE = { presentation: null, page: 1, camera: null, shapes: new Map() };
const removedFields = (old, next) => old && typeof old === 'object' && !Array.isArray(old)
  && Object.keys(old).some(key => !Object.prototype.hasOwnProperty.call(next || {}, key)
    || removedFields(old[key], next?.[key]));

function removeShapes(editor, ids) {
  // Recorded shapes can be locked. The public delete API skips locked shapes.
  const locked = ids.filter(id => editor.getShape(id)?.isLocked);
  if (locked.length) editor.updateShapes(locked.map(id => ({ id, type: editor.getShape(id).type, isLocked: false })), { ephemeral: true });
  if (ids.length) editor.deleteShapes(ids);
}

function displayShape(raw, page) {
  const { isModerator, ...shape } = raw;
  if (shape.props) {
    shape.props = { ...shape.props };
    ['start', 'end'].forEach(key => {
      if (shape.props[key]?.type === 'point') shape.props[key] = { type: 'point', x: shape.props[key].x, y: shape.props[key].y };
    });
  }
  return { ...shape, parentId: page };
}

export default function SlidePreview({ recording, time }) {
  const { t, message } = useEditorI18n();
  const timeline = useMemo(() => createSlideTimeline(recording.events), [recording.events]);
  const [resolved, setResolved] = useState(null);
  // Effects own the mutable replay cursor; abandoned React renders cannot move it.
  useLayoutEffect(() => {
    const state = timeline.at(time);
    setResolved(previous => previous?.timeline === timeline && previous.state === state ? previous : { timeline, state });
  }, [timeline, time]);
  const state = resolved?.timeline === timeline ? resolved.state : EMPTY_STATE;
  const slides = useMemo(() => {
    const index = new Map();
    recording.slides.forEach(slide => {
      const key = `${slide.presentation}:${slide.page}`;
      if (!index.has(key)) index.set(key, slide); // Keep the preferred SVG first.
    });
    return index;
  }, [recording.slides]);
  const slide = slides.get(`${state.presentation}:${state.page}`);
  const [editor, setEditor] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 1440, height: 1080 });
  const [error, setError] = useState('');
  const container = useRef(null);
  const applied = useRef({ editor: null, shapes: new Map() });
  const mount = useCallback(instance => {
    // Readonly prevents shape edits, but Tldraw still allows wheel/pinch panning.
    // Recorded camera changes use setCamera, which remains available when locked.
    instance.updateInstanceState({ canMoveCamera: false });
    setEditor(instance);
  }, []);
  useEffect(() => {
    if (!slide) return undefined;
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (alive) setDimensions({ width: image.naturalWidth || 1440, height: image.naturalHeight || 1080 });
    };
    image.src = slide.url;
    return () => { alive = false; };
  }, [slide]);

  useEffect(() => {
    if (!editor || !slide) return undefined;
    const ratio = Math.min(1440 / dimensions.width, 1080 / dimensions.height);
    const width = dimensions.width * ratio;
    const height = dimensions.height * ratio;
    const page = editor.getCurrentPageId();
    const assetId = AssetRecordType.createId('editor-background');
    const previous = applied.current.editor === editor ? applied.current.shapes : new Map();
    const next = new Map();
    let invalid = 0;
    try {
      editor.batch(() => {
        editor.updateInstanceState({ isReadonly: false });
        try {
          // A page switch replaces its annotations; the background stays mounted.
          const removed = [...previous.keys()].filter(id => !state.shapes.has(id));
          removeShapes(editor, removed);
          const asset = createTldrawImageAsset(assetId, slide.url, width, height);
          const oldAsset = editor.getAsset(assetId);
          if (!oldAsset) editor.createAssets([asset]);
          else if (oldAsset.props.src !== slide.url || oldAsset.props.w !== width || oldAsset.props.h !== height) editor.updateAssets([asset]);
          const background = { ...createTldrawBackgroundShape(assetId, page, width, height), parentId: page };
          const oldBackground = editor.getShape(background.id);
          if (!oldBackground) editor.createShapes([background]);
          else if (oldBackground.props.w !== width || oldBackground.props.h !== height) editor.updateShapes([background], { ephemeral: true });
          state.shapes.forEach((raw, id) => {
            if (previous.get(id) === raw && editor.getShape(id)) { next.set(id, raw); return; }
            try {
              const shape = displayShape(raw, page);
              const old = previous.get(id);
              // updateShapes merges props. Recreate just this shape when a seek
              // removes fields, so future values do not leak into earlier frames.
              if (editor.getShape(id) && (old?.type !== raw.type || removedFields(old, raw))) removeShapes(editor, [id]);
              if (editor.getShape(id)) editor.updateShapes([shape], { ephemeral: true });
              else editor.createShapes([shape]);
              next.set(id, raw);
            } catch {
              // An invalid new snapshot must not leave its older frame visible.
              if (editor.getShape(id)) removeShapes(editor, [id]);
              invalid += 1;
            }
          });
        } finally {
          editor.updateInstanceState({ isReadonly: true });
          // Playback has no editor undo UI. Do not retain every replayed frame.
          editor.history.clear();
        }
      });
      applied.current = { editor, shapes: next };
      setError(invalid ? { id: 'invalidShapes', values: { count: invalid } } : '');
    } catch {
      applied.current = { editor, shapes: next };
      setError({ id: 'shapeError' });
    }
  }, [editor, slide, state.shapes, dimensions]);

  useEffect(() => {
    if (!editor || !slide) return undefined;
    const ratio = Math.min(1440 / dimensions.width, 1080 / dimensions.height);
    const width = dimensions.width * ratio;
    const height = dimensions.height * ratio;
    const fit = () => {
      if (!container.current) return;
      const bounds = container.current.getBoundingClientRect();
      const camera = state.camera;
      const w = width * ((camera?.widthRatio || 100) / 100);
      const h = height * ((camera?.heightRatio || 100) / 100);
      const z = Math.min(bounds.width / w, bounds.height / h);
      // BBB pan offsets already use Tldraw slide coordinates. Only the
      // width/height ratios are percentages; scaling offsets again hides slides.
      const x = (camera?.xOffset || 0) + (bounds.width / z - w) / 2;
      const y = (camera?.yOffset || 0) + (bounds.height / z - h) / 2;
      if (Number.isFinite(z) && z > 0) editor.setCamera({ x, y, z });
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(container.current);
    return () => resize.disconnect();
  }, [editor, slide, state.camera, dimensions]);

  if (!slide) return <div className="re-placeholder">{t('noSlide')}</div>;
  return <div className="re-slide" ref={container}>
    <Tldraw hideUi autoFocus={false} onMount={mount} />
    {error && <span className="re-render-warning">{message(error)}</span>}
    <span className="re-slide-label">{t('slide', { page: state.page })}</span>
  </div>;
}
