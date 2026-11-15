import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import EditorToast from './EditorToast';
import { EditorLanguageProvider } from './i18n';

let root, container, dismiss;
const item = { id: 1, kind: 'success', message: { id: 'draftSaved' } };
const render = props => act(async () => root.render(<EditorLanguageProvider><EditorToast busy="" toast={item} dismiss={dismiss} onDetails={() => {}} {...props} /></EditorLanguageProvider>));
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers(); dismiss = jest.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); });

test('notifications expire after five seconds even as the editor re-renders', async () => {
  await render();
  await act(async () => jest.advanceTimersByTime(4900));
  await render();
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(100));
  expect(dismiss).toHaveBeenCalledTimes(1);
});

test('hover and keyboard focus pause expiration; the message and close buttons dismiss it', async () => {
  await render();
  const toast = container.querySelector('.re-toast');
  await act(async () => Simulate.mouseEnter(toast));
  await act(async () => jest.advanceTimersByTime(6000));
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => { Simulate.mouseLeave(toast); Simulate.focus(toast); });
  await act(async () => jest.advanceTimersByTime(6000));
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => Simulate.blur(toast, { relatedTarget: document.body }));
  await act(async () => jest.advanceTimersByTime(5000));
  expect(dismiss).toHaveBeenCalledTimes(1);
  await act(async () => Simulate.click(container.querySelector('.re-toast-message')));
  await act(async () => Simulate.click(container.querySelector('[aria-label]')));
  expect(dismiss).toHaveBeenCalledTimes(3);
});

test('progress updates replace the same toast without extending its lifetime or resurrecting a dismissed toast', async () => {
  await render({ busy: 'Processing audio 1/10', toast: null });
  expect(container.querySelector('.re-toast-message').textContent).toContain('1/10');
  await act(async () => jest.advanceTimersByTime(4000));
  await render({ busy: 'Processing audio 9/10', toast: null });
  await act(async () => jest.advanceTimersByTime(1000));
  expect(container.querySelector('.re-toast')).toBeNull();
  await render({ busy: 'Processing audio 10/10', toast: null });
  expect(container.querySelector('.re-toast')).toBeNull();
  await render({ busy: '', toast: { ...item, id: 2 } });
  expect(container.querySelector('.re-toast-message').textContent).toContain('Draft saved');
});

test('a new completion gets its own timer and raw backups are kept out of the brief toast', async () => {
  await render();
  await act(async () => jest.advanceTimersByTime(4000));
  await render({ toast: { id: 2, kind: 'success', message: { id: 'rawSaved', values: { backup: '/private/path/events.xml' } } } });
  expect(container.textContent).not.toContain('/private/path');
  expect(container.textContent).toContain('Rebuild');
  await act(async () => jest.advanceTimersByTime(1000));
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(4000));
  expect(dismiss).toHaveBeenCalledTimes(1);
});
