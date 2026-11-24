import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildPanelState,
  handleResetStats,
  handleSetPreset,
  handleSetRecovery,
} from './panel-logic.mjs';
import { PluginUpdater } from './updater.mjs';

const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(PANEL_DIR, '..', '..');
const INDEX_HTML_PATH = path.join(PANEL_DIR, 'index.html');

// 启动后释放插件目录句柄，避免 Windows 下阻塞后续文件更新或卸载
try {
  process.chdir(os.tmpdir());
} catch {
  // 忽略受限环境下的 chdir 失败
}

const loadSidecarSdk = async () => {
  try {
    const mod = await import('sidecar_sdk');
    if (mod && typeof mod.SidecarApp === 'function') {
      return mod;
    }
  } catch {
    // 回退至 createRequire 解析以兼容 NODE_PATH
  }

  const resolvedPath = createRequire(import.meta.url).resolve('sidecar_sdk');
  const fileUrl = resolvedPath.startsWith('file://')
    ? resolvedPath
    : pathToFileURL(resolvedPath).href;
  return import(fileUrl);
};

const jsonErrorResponse = (Response, status, error) =>
  new Response(JSON.stringify({ error }), {
    status,
    contentType: 'application/json; charset=utf-8',
  });

const start = async () => {
  const { SidecarApp, Response } = await loadSidecarSdk();
  const app = new SidecarApp();
  const shutdown = () => {
    app.close().finally(() => process.exit(0));
  };
  const updater = new PluginUpdater({
    pluginDir: PLUGIN_ROOT,
    onReload: shutdown,
  });

  app.page('/', () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    return new Response(html, {
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
    });
  });

  app.api('/api/state', () => buildPanelState(), 'GET');

  app.api(
    '/api/preset',
    (data) => {
      const result = handleSetPreset(data);
      return result.ok ? result.state : jsonErrorResponse(Response, result.status, result.error);
    },
    'POST',
  );

  app.api(
    '/api/recovery',
    (data) => {
      const result = handleSetRecovery(data);
      return result.ok ? result.state : jsonErrorResponse(Response, result.status, result.error);
    },
    'POST',
  );

  app.api('/api/stats/reset', () => handleResetStats().state, 'POST');

  app.api(
    '/api/update',
    (data) => {
      const result = updater.request(data);
      return result.ok ? result.state : jsonErrorResponse(Response, result.status, result.error);
    },
    'POST',
  );

  await app.run();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start().catch((error) => {
  console.error('[chunked-write-guard sidecar] startup failed:', error);
  process.exit(1);
});
