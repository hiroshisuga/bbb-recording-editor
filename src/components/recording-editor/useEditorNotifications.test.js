import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import useEditorNotifications from './useEditorNotifications';

let root, container, state;
function Probe() { state = useEditorNotifications(); return null; }
beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('dismissing a toast preserves the error and reviewable history', async () => {
  await act(async () => state.setError('Save failed'));
  await act(async () => state.dismiss());
  expect(state.toast).toBeNull(); expect(state.error).toBe('Save failed');
  expect(state.entries).toHaveLength(1);
  await act(async () => state.setError(''));
  expect(state.error).toBe(''); expect(state.entries[0].message).toBe('Save failed');
});

test('repeated polling errors do not flood notifications, but retry failures can notify again', async () => {
  await act(async () => state.setError({ id: 'rebuildFailed' }));
  await act(async () => state.dismiss());
  await act(async () => state.setError({ id: 'rebuildFailed' }));
  expect(state.entries).toHaveLength(1); expect(state.toast).toBeNull();
  await act(async () => state.setError(''));
  await act(async () => state.setError({ id: 'rebuildFailed' }));
  expect(state.entries).toHaveLength(2); expect(state.toast).not.toBeNull();
});

test('history is bounded and cleared when switching recording scope', async () => {
  await act(async () => { for (let i = 0; i < 25; i += 1) state.setMessage(`Saved ${i}`); });
  expect(state.entries).toHaveLength(20); expect(state.entries[0].message).toBe('Saved 5');
  await act(async () => state.clear());
  expect(state.entries).toEqual([]); expect(state.toast).toBeNull(); expect(state.error).toBe('');
  await act(async () => state.setMessage('New recording'));
  expect(state.entries).toHaveLength(1); expect(state.toast.message).toBe('New recording');
});

test('unrelated operations cannot clear unreviewed errors and successful retries resolve only their source', async () => {
  await act(async () => state.setError('Audio failed', 'audio'));
  await act(async () => { state.setError('', 'draft'); state.setMessage('Draft saved'); });
  expect(state.unresolvedErrors.map(item => item.source)).toEqual(['audio']);
  await act(async () => state.setError('Save failed', 'save'));
  expect(state.unresolvedErrors).toHaveLength(2);
  await act(async () => state.resolveError('save'));
  expect(state.unresolvedErrors.map(item => item.source)).toEqual(['audio']);
  await act(async () => state.resolveError('audio'));
  expect(state.unresolvedErrors).toEqual([]);
  expect(state.entries.filter(item => item.kind === 'error')).toHaveLength(2);
});
