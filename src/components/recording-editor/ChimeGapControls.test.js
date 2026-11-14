import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import ChimeGapControls, { clusterChimeGaps } from './ChimeGapControls';
import { EditorLanguageProvider } from './i18n';

const small = [{ start_ms: 1000, end_ms: 1020 }, { start_ms: 1022, end_ms: 1042 }];
const distant = { start_ms: 30000, end_ms: 40000 };
let root, container, onToggle;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  onToggle = jest.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = props => act(async () => root.render(<EditorLanguageProvider><ChimeGapControls gaps={[...small, distant]} selected={[]}
  duration={60000} width={650} onToggle={onToggle} {...props} /></EditorLanguageProvider>));

test('nearby cuts cluster without overlapping touch targets, including the timeline edges', () => {
  const gaps = [...small, distant, { start_ms: 59970, end_ms: 59999 }];
  const clusters = clusterChimeGaps(gaps, 60000, 650);
  expect(clusters.map(group => group.gaps.length)).toEqual([2, 1, 1]);
  expect(clusters[0].center).toBeGreaterThanOrEqual(22);
  expect(clusters.at(-1).center).toBeLessThanOrEqual(628);
  clusters.slice(1).forEach((group, index) => expect(group.center - clusters[index].center).toBeGreaterThanOrEqual(48));
});

test('a normal cut toggles directly while a cluster exposes individually labeled keyboard actions', async () => {
  await render();
  const buttons = container.querySelectorAll('button');
  expect(buttons).toHaveLength(2);
  await act(async () => Simulate.click(buttons[1]));
  expect(onToggle).toHaveBeenLastCalledWith(distant, true);
  await act(async () => Simulate.click(buttons[0]));
  const menu = document.querySelector('[role="menu"]');
  const options = menu.querySelectorAll('[role="menuitemcheckbox"]');
  expect(options).toHaveLength(2);
  expect(options[1].textContent).toContain('00:00:01.022');
  expect(document.activeElement).toBe(options[0]);
  await act(async () => Simulate.keyDown(menu, { key: 'ArrowDown' }));
  expect(document.activeElement).toBe(options[1]);
  await act(async () => Simulate.click(options[1]));
  expect(onToggle).toHaveBeenLastCalledWith(small[1], true);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(buttons[0]);
});

test('enabled state, disabled actions and resizing preserve the selected gap identities', async () => {
  await render({ gaps: [distant], selected: [distant] });
  const button = container.querySelector('button');
  expect(button.textContent).toBe('♪');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  await act(async () => Simulate.click(button));
  expect(onToggle).toHaveBeenLastCalledWith(distant, false);
  await render({ busy: true });
  expect([...container.querySelectorAll('button')].every(node => node.disabled)).toBe(true);
  await render({ width: 100000, selected: [small[1]] });
  // The two tiny cuts remain a single accessible cluster even at this zoom.
  expect(container.querySelector('.re-chime-cluster')).not.toBeNull();
  expect(container.querySelectorAll('.re-chime-cue')).toHaveLength(1);
});
