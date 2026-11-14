#!/usr/bin/env node
// Synthetic local comparison of the actual React/Tldraw preview. No BBB data.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const webpack = require('webpack');

async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (!options.before || !options.browser || !options.output) throw new Error('Usage: node scripts/benchmark-slide-preview.cjs --before REF --browser CHROMIUM --output FILE [--playwright MODULE_PATH]');
  const repo = path.resolve(__dirname, '..');
  const component = path.join(repo, 'src/components/recording-editor');
  fs.mkdirSync(path.join(repo, 'work'), { recursive: true });
  const temp = fs.mkdtempSync(path.join(repo, 'work/slide-benchmark-'));
  let browser, server;
  try {
    let before = execFileSync('git', ['show', `${options.before}:src/components/recording-editor/SlidePreview.js`], { cwd: repo, encoding: 'utf8' });
    before = before.replace(/from '(\.\/[^']+)'/g, (_, relative) => `from ${JSON.stringify(path.resolve(component, relative))}`);
    fs.writeFileSync(path.join(temp, 'before.js'), before);
    fs.writeFileSync(path.join(temp, 'entry.js'), `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Editor, setDefaultEditorAssetUrls, setDefaultUiAssetUrls } from '@bigbluebutton/tldraw';
      import Before from './before';
      import After from ${JSON.stringify(path.join(component, 'SlidePreview'))};
      import { EditorLanguageProvider } from ${JSON.stringify(path.join(component, 'i18n'))};
      import ${JSON.stringify(path.join(component, 'styles.css'))};
      // Keep font loading local; these fixtures contain geometry, not text.
      const fonts = Object.fromEntries(['draw', 'serif', 'sansSerif', 'monospace'].map(key => [key, '/font.ttf']));
      setDefaultEditorAssetUrls({ fonts });
      setDefaultUiAssetUrls({ fonts, icons: {}, embedIcons: {}, translations: { en: '/translation.json', ja: '/translation.json' } });
      const root = createRoot(document.getElementById('root'));
      const counts = {};
      for (const name of ['createShapes', 'updateShapes', 'deleteShapes']) {
        const original = Editor.prototype[name];
        Editor.prototype[name] = function(...args) {
          counts[name] = (counts[name] || 0) + 1;
          window.editor = this;
          return original.apply(this, args);
        };
      }
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      window.run = async (variant, count) => {
        const Component = variant === 'before' ? Before : After;
        const recording = { events: [
          { type: 'SharePresentationEvent', time_ms: 0, presentation: 'p', page: 1 },
          ...Array.from({ length: count }, (_, i) => ({ type: 'AddTldrawShapeEvent', time_ms: i + 1,
            presentation: 'p', page: 1, shape_id: 'shape:s' + i % 100,
            shape: { id: 'shape:s' + i % 100, type: 'geo', x: i % 997, y: i % 499, props: { w: 20, h: 20 } } })),
          { type: 'SendPublicChatEvent', time_ms: count + 1, message: 'chat' },
        ], slides: [{ presentation: 'p', page: 1, url: '/slide.svg' }] };
        const render = time => flushSync(() => root.render(<EditorLanguageProvider><Component recording={recording} time={time}/></EditorLanguageProvider>));
        render(count - 20);
        const loadingStarted = performance.now();
        while (!window.editor || window.editor.getCurrentPageShapeIds().size < 101) {
          if (performance.now() - loadingStarted > 20000) throw new Error('Tldraw did not initialize: ' + document.body.innerText);
          await frame();
        }
        await frame(); await frame();
        for (let i = 19; i > 15; i--) { render(count - i); await frame(); }
        const times = [];
        for (const name of Object.keys(counts)) counts[name] = 0;
        for (let i = 15; i >= 0; i--) {
          const start = performance.now(); render(count - i); times.push(performance.now() - start);
          await frame();
        }
        const drawing = { ...counts };
        for (const name of Object.keys(counts)) counts[name] = 0;
        render(count + 1); await frame();
        const unrelatedDrawing = { ...counts };
        const shapes = [...window.editor.getCurrentPageShapeIds()].map(id => window.editor.getShape(id)).filter(s => s.type === 'geo');
        times.sort((a,b) => a-b);
        const result = { variant, events: count, visibleShapes: shapes.length, samples: times.length,
          medianCommitMs: times[Math.floor(times.length / 2)], maxCommitMs: times[times.length - 1], drawing, unrelatedDrawing };
        render(10); await frame(); render(count); await frame();
        if ([...window.editor.getCurrentPageShapeIds()].length !== 101) throw new Error('Incorrect shape count after seek');
        return result;
      };
    `);
    process.env.BABEL_ENV = 'production';
    await new Promise((resolve, reject) => webpack({
      mode: 'production', entry: path.join(temp, 'entry.js'), output: { path: temp, filename: 'bundle.js' },
      resolve: { extensions: ['.js', '.mjs', '.json'], modules: [path.join(repo, 'node_modules'), 'node_modules'] },
      module: { rules: [
        { test: /\.js$/, exclude: /node_modules/, use: { loader: require.resolve('babel-loader'), options: { presets: [require.resolve('babel-preset-react-app')] } } },
        { test: /\.css$/, use: [require.resolve('style-loader'), require.resolve('css-loader')] },
      ] },
      plugins: [new webpack.DefinePlugin({ 'process.env': `(${JSON.stringify({ NODE_ENV: 'production' })})` })],
      optimization: { minimize: false, concatenateModules: false }, performance: { hints: false },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()));
    server = http.createServer((req, res) => {
      if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); fs.createReadStream(path.join(temp, 'bundle.js')).pipe(res); }
      else if (req.url === '/font.ttf') { res.setHeader('Content-Type', 'font/ttf'); fs.createReadStream('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf').pipe(res); }
      else if (req.url === '/translation.json') { res.setHeader('Content-Type', 'application/json'); res.end('{}'); }
      else if (req.url === '/slide.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1080"><rect width="1440" height="1080" fill="white"/></svg>'); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div class="recording-editor" id="root" style="width:900px;height:650px"></div><script src="/bundle.js"></script>'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { chromium } = require(options.playwright || 'playwright');
    browser = await chromium.launch({ executablePath: options.browser, headless: true, args: ['--no-sandbox'] });
    const result = { before: options.before, at: new Date().toISOString(), browser: browser.version(), cpu: os.cpus()[0]?.model,
      scope: 'Synthetic React/Tldraw synchronous commits; excludes paint, media playback and BBB server. Non-minified production-mode harness.', cases: [] };
    for (const count of [10000, 50000]) for (const variant of ['before', 'after']) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => typeof window.run === 'function');
      console.log(`Starting ${variant}: ${count} events`);
      const row = await page.evaluate(({ variant, count }) => window.run(variant, count), { variant, count });
      if (errors.length) throw new Error(errors.join('\n'));
      result.cases.push(row);
      console.log(JSON.stringify(row));
      await page.close();
    }
    fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
