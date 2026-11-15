import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import EditorDialog from './EditorDialog';
import { EditorLanguageProvider } from './i18n';

let root, container, setOpen, setTransient;
function Probe() {
  const [open, updateOpen] = useState(false), [transient, updateTransient] = useState(true);
  setOpen = updateOpen; setTransient = updateTransient;
  return <div className="recording-editor"><button className="re-status-toggle">Status</button>{transient && <button className="temporary">Toast details</button>}
    {open && <EditorDialog title="Review" onClose={() => updateOpen(false)}><p>Review information</p></EditorDialog>}</div>;
}
beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<EditorLanguageProvider><Probe /></EditorLanguageProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('closing a dialog restores the invoking control', async () => {
  const button = container.querySelector('.re-status-toggle'); button.focus();
  await act(async () => setOpen(true));
  const dialog = container.querySelector('dialog');
  expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2').id);
  await act(async () => Simulate.click(dialog.querySelector('button')));
  expect(container.querySelector('dialog')).toBeNull(); expect(document.activeElement).toBe(button);
});

test('an expired toast origin returns focus to the persistent status control', async () => {
  container.querySelector('.temporary').focus();
  await act(async () => setOpen(true));
  await act(async () => setTransient(false));
  await act(async () => Simulate.click(container.querySelector('dialog button')));
  expect(document.activeElement).toBe(container.querySelector('.re-status-toggle'));
});
