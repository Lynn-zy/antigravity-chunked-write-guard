import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PluginUpdater,
  RUNTIME_ENTRIES,
  compareSemver,
  downloadTarball,
  extractAndVerifyTarball,
  fetchLatestReleaseInfo,
  parseSemver,
  swapRuntimeEntries,
} from '../sidecars/panel/updater.mjs';
import { readSettings, updateSettings } from './config.mjs';
import { readTriggerStats, recordTriggerEvent } from './stats.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const createMockJsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  url: 'https://api.github.com/mock',
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
});

const createMockStreamResponse = (buffer, url = 'https://codeload.github.com/mock.tar.gz') => {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-length': String(bytes.byteLength) }),
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.byteLength) {
            return { done: true, value: undefined };
          }
          const chunk = bytes.subarray(offset, offset + 16_384);
          offset += chunk.byteLength;
          return { done: false, value: chunk };
        },
      }),
    },
  };
};

const copyRuntimeFixture = (destDir, version) => {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of RUNTIME_ENTRIES) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(destDir, entry), { recursive: true });
  }
  const manifestPath = path.join(destDir, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};

const packTarballFixture = (workDir, folderName, version) => {
  const stagingParent = path.join(workDir, `pack-${version}`);
  const pkgDir = path.join(stagingParent, folderName);
  copyRuntimeFixture(pkgDir, version);
  const tarballPath = path.join(workDir, `v${version}.tar.gz`);
  execFileSync('tar', ['-czf', tarballPath, '-C', stagingParent, folderName], {
    windowsHide: true,
  });
  return tarballPath;
};

test('parseSemver and compareSemver accept strict X.Y.Z and reject prereleases', () => {
  assert.deepEqual(parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3, normalized: '1.2.3' });
  assert.deepEqual(parseSemver('2.0.10'), { major: 2, minor: 0, patch: 10, normalized: '2.0.10' });
  assert.equal(parseSemver('v1.3.0-beta.1'), null);
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver(123), null);

  assert.equal(compareSemver('1.3.0', '1.2.9'), 1);
  assert.equal(compareSemver('v1.2.0', '1.2.0'), 0);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
});

test('fetchLatestReleaseInfo prefers Releases and falls back to highest stable Tag on 404', async () => {
  const releaseFetch = async (url) => {
    assert.match(url, /\/releases\/latest$/);
    return createMockJsonResponse(200, {
      tag_name: 'v3.1.0',
      tarball_url: 'https://api.github.com/repos/Lynn-zy/antigravity-rail/tarball/v3.1.0',
      html_url: 'https://github.com/Lynn-zy/antigravity-rail/releases/tag/v3.1.0',
      body: '## 新增\n- 面板内更新',
      published_at: '2026-11-26T00:00:00Z',
    });
  };
  const fromRelease = await fetchLatestReleaseInfo({ fetchImpl: releaseFetch });
  assert.equal(fromRelease.source, 'release');
  assert.equal(fromRelease.version, '3.1.0');
  assert.match(fromRelease.releaseNotes, /面板内更新/);

  const tagFallbackFetch = async (url) => {
    if (url.endsWith('/releases/latest')) {
      return createMockJsonResponse(404, { message: 'Not Found' });
    }
    return createMockJsonResponse(200, [
      { name: 'v1.4.0-rc.1' },
      { name: 'v1.2.0' },
      { name: 'v1.3.2', tarball_url: 'https://api.github.com/repos/x/y/tarball/v1.3.2' },
      { name: 'v1.3.1' },
    ]);
  };
  const fromTag = await fetchLatestReleaseInfo({ fetchImpl: tagFallbackFetch });
  assert.equal(fromTag.source, 'tag');
  assert.equal(fromTag.version, '1.3.2');
  assert.equal(fromTag.releaseNotes, '');

  const rateLimitedFallbackFetch = async (url) => {
    if (url.startsWith('https://api.github.com/')) {
      return createMockJsonResponse(403, { message: 'rate limit' });
    }
    if (url.endsWith('/releases/latest')) {
      return { ok: true, status: 200, url: 'https://github.com/Lynn-zy/antigravity-rail/releases' };
    }
    if (url.endsWith('/tags.atom')) {
      return {
        ok: true,
        status: 200,
        url,
        text: async () =>
          '<feed><entry><link href="https://github.com/Lynn-zy/antigravity-rail/releases/tag/v3.4.0-rc.1"/></entry>' +
          '<entry><link href="https://github.com/Lynn-zy/antigravity-rail/releases/tag/v3.3.5"/></entry></feed>',
      };
    }
    if (url.endsWith('/v3.3.5/CHANGELOG.md')) {
      return {
        ok: true,
        status: 200,
        url,
        text: async () =>
          '# Changelog\n\n## [3.3.5] - 2026-11-26\n\n### Fixed\n- 修复 Windows 目录锁导致替换失败\n\n## [3.0.0] - 2026-11-26\n- 旧记录\n',
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const fromPublicAtom = await fetchLatestReleaseInfo({ fetchImpl: rateLimitedFallbackFetch });
  assert.equal(fromPublicAtom.source, 'tag');
  assert.equal(fromPublicAtom.version, '3.3.5');
  assert.match(fromPublicAtom.releaseNotes, /修复 Windows 目录锁导致替换失败/);
  assert.doesNotMatch(fromPublicAtom.releaseNotes, /旧记录/);
  assert.match(fromPublicAtom.tarballUrl, /^https:\/\/github\.com\/.*\/archive\/refs\/tags\/v3\.3\.5\.tar\.gz$/);

  const allFailedFetch = async () => createMockJsonResponse(403, { message: 'rate limit' });
  await assert.rejects(() => fetchLatestReleaseInfo({ fetchImpl: allFailedFetch }), /rate limit exceeded/);
});

test('downloadTarball rejects disallowed hosts and enforces size limit', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dl-test-'));
  try {
    await assert.rejects(
      () => downloadTarball('https://evil.example.com/pkg.tar.gz', path.join(tempDir, 'a.tgz')),
      /non-allowlisted host/,
    );
    await assert.rejects(
      () => downloadTarball('http://github.com/pkg.tar.gz', path.join(tempDir, 'b.tgz')),
      /non-HTTPS/,
    );

    const bigBuf = Buffer.alloc(1024, 0x61);
    await assert.rejects(
      () =>
        downloadTarball('https://codeload.github.com/pkg.tar.gz', path.join(tempDir, 'c.tgz'), {
          maxBytes: 512,
          fetchImpl: async () => createMockStreamResponse(bigBuf),
        }),
      /safety size limit/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('PluginUpdater end-to-end check, install, config preservation, and reload flow', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-e2e-update-'));
  try {
    const installedDir = path.join(tempDir, 'installed');
    copyRuntimeFixture(installedDir, '1.2.0');

    // 预置用户的自定义档位、模块开关与触发统计
    const configPath = path.join(installedDir, 'config', 'settings.json');
    const rulesPath = path.join(installedDir, 'rules', 'AGENTS.md');
    const eventsPath = path.join(installedDir, 'config', 'events.jsonl');
    updateSettings(
      {
        writeGuard: { presetId: '300', hookEnabled: false },
        responsive: { silentThreshold: 4 },
        toolLocale: { enabled: false },
      },
      { configPath, rulesPath },
    );
    recordTriggerEvent('write_oversize', { eventsPath, timestamp: '2026-11-26T01:00:00.000Z' });

    const tarballPath = packTarballFixture(tempDir, 'antigravity-rail-v3.1.0', '3.1.0');
    const tarballBytes = fs.readFileSync(tarballPath);
    const tarballUrl = 'https://codeload.github.com/Lynn-zy/antigravity-rail/tar.gz/v3.1.0';

    let clock = 1_000_000;
    let checkCalls = 0;
    let reloaded = false;
    const mockFetch = async (url) => {
      if (url.endsWith('/releases/latest')) {
        checkCalls += 1;
        return createMockJsonResponse(200, {
          tag_name: 'v3.1.0',
          tarball_url: tarballUrl,
          html_url: 'https://github.com/Lynn-zy/antigravity-rail/releases/tag/v3.1.0',
          body: '新增面板更新测试',
        });
      }
      if (url === tarballUrl) {
        return createMockStreamResponse(tarballBytes, tarballUrl);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const updater = new PluginUpdater({
      pluginDir: installedDir,
      fetchImpl: mockFetch,
      now: () => clock,
      reloadDelayMs: 20,
      onReload: () => {
        reloaded = true;
      },
    });

    // 非法字段与非法 action 均应返回 400
    assert.equal(updater.request({ action: 'status', extra: 1 }).ok, false);
    assert.equal(updater.request({ action: 'unknown' }).ok, false);
    assert.equal(updater.request({ action: 'apply', version: '3.1.0' }).ok, false);

    // 检查更新
    const checking = updater.request({ action: 'check' });
    assert.equal(checking.ok, true);
    assert.equal(checking.state.status, 'checking');
    const checked = await updater.waitForIdle();
    assert.equal(checked.status, 'available');
    assert.equal(checked.currentVersion, '1.2.0');
    assert.equal(checked.latestVersion, '3.1.0');
    assert.equal(checkCalls, 1);

    // 15 秒冷却期内重复 check 应复用缓存结果，不发重复网络请求
    const cooled = updater.request({ action: 'check' });
    assert.equal(cooled.state.status, 'available');
    assert.equal(checkCalls, 1);

    // 版本号不匹配时拒绝安装
    assert.equal(updater.request({ action: 'apply', version: '9.9.9' }).ok, false);

    // 超过计划 TTL（15 分钟）后应拒绝安装并重置为空闲态
    clock += 16 * 60_000;
    assert.equal(updater.request({ action: 'apply', version: '3.1.0' }).ok, false);

    // 重新检查并执行完整安装
    updater.request({ action: 'check' });
    await updater.waitForIdle();
    const applying = updater.request({ action: 'apply', version: '3.1.0' });
    assert.equal(applying.ok, true);
    assert.equal(applying.state.status, 'installing');

    const installed = await updater.waitForIdle();
    assert.equal(installed.status, 'installed');
    assert.equal(installed.currentVersion, '3.1.0');

    // 已安装待重载期间再次 check 不得覆盖 installed 状态
    clock += 60_000;
    assert.equal(updater.request({ action: 'check' }).state.status, 'installed');

    // 校验插件已更新至 v3.1.0，同时保留用户配置、开关与统计日志
    const nextManifest = JSON.parse(fs.readFileSync(path.join(installedDir, 'plugin.json'), 'utf8'));
    assert.equal(nextManifest.version, '3.1.0');
    const preserved = readSettings({ configPath });
    assert.equal(preserved.writeGuard.presetId, '300');
    assert.equal(preserved.writeGuard.hookEnabled, false);
    assert.equal(preserved.responsive.silentThreshold, 4);
    assert.equal(preserved.toolLocale.enabled, false);
    assert.equal(readTriggerStats({ eventsPath }).writeOversizeCount, 1);
    const syncedRules = fs.readFileSync(rulesPath, 'utf8');
    assert.match(syncedRules, /300 lines · Conservative/);
    assert.doesNotMatch(syncedRules, /## Match User's Language for Tool Summaries/);

    // 触发重载回调
    const reloading = updater.request({ action: 'reload' });
    assert.equal(reloading.ok, true);
    assert.equal(reloading.state.status, 'reloading');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(reloaded, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('extractAndVerifyTarball rejects version mismatch and swapRuntimeEntries rolls back on error', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-rollback-test-'));
  try {
    const tarballPath = packTarballFixture(tempDir, 'pkg-1.2.5', '1.2.5');
    await assert.rejects(
      () => extractAndVerifyTarball(tarballPath, path.join(tempDir, 'bad-extract'), '1.3.0'),
      /version mismatch/,
    );

    const installedDir = path.join(tempDir, 'installed');
    const newSourceDir = path.join(tempDir, 'source');
    const backupDir = path.join(tempDir, 'backup');
    copyRuntimeFixture(installedDir, '1.2.0');
    copyRuntimeFixture(newSourceDir, '1.3.0');
    fs.mkdirSync(path.join(installedDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'config', 'events.jsonl'), '{"type":"oversize"}\n', 'utf8');

    const phases = [];
    await assert.rejects(
      () =>
        swapRuntimeEntries(newSourceDir, installedDir, backupDir, {
          onPhase: (phase) => phases.push(phase),
          syncRules: async () => {
            throw new Error('simulated rule sync error');
          },
        }),
      /rolled back to previous version/,
    );

    assert.deepEqual(phases, ['backup', 'install', 'recover']);
    const restoredManifest = JSON.parse(
      fs.readFileSync(path.join(installedDir, 'plugin.json'), 'utf8'),
    );
    assert.equal(restoredManifest.version, '1.2.0');
    assert.equal(
      fs.readFileSync(path.join(installedDir, 'config', 'events.jsonl'), 'utf8'),
      '{"type":"oversize"}\n',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('swapRuntimeEntries succeeds and rolls back even when sidecars/panel directory is locked', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dirlock-test-'));
  let holder = null;
  try {
    const installedDir = path.join(tempDir, 'installed');
    const newSourceDir = path.join(tempDir, 'source');
    const backupDir = path.join(tempDir, 'backup');
    copyRuntimeFixture(installedDir, '1.2.0');
    copyRuntimeFixture(newSourceDir, '1.3.0');
    // 在旧版新增一个待清理的废弃文件，并在新版新增一个额外文件用于验证回滚清理
    fs.writeFileSync(path.join(installedDir, 'sidecars', 'panel', 'obsolete.txt'), 'old', 'utf8');
    fs.writeFileSync(path.join(newSourceDir, 'sidecars', 'panel', 'added.txt'), 'new', 'utf8');

    // 启动子进程将工作目录锁在 sidecars/panel，真实复现 Windows 目录句柄占用
    const panelDir = path.join(installedDir, 'sidecars', 'panel');
    holder = spawn(process.execPath, ['-e', 'console.log("locked"); setTimeout(() => {}, 30000);'], {
      cwd: panelDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('exit', () => reject(new Error('holder exited early')));
    });

    // 1. 目录被锁时安装失败仍能完整回滚，且不会清空 sidecars/panel
    await assert.rejects(
      () =>
        swapRuntimeEntries(newSourceDir, installedDir, backupDir, {
          syncRules: async () => {
            throw new Error('simulated fault');
          },
        }),
      /rolled back to previous version/,
    );
    assert.equal(fs.existsSync(path.join(panelDir, 'main.mjs')), true);
    assert.equal(fs.existsSync(path.join(panelDir, 'obsolete.txt')), true);
    assert.equal(fs.existsSync(path.join(panelDir, 'added.txt')), false);

    // 2. 目录被锁时正常升级应完全成功、更新版本并清理废弃旧文件
    const backupDir2 = path.join(tempDir, 'backup-2');
    await swapRuntimeEntries(newSourceDir, installedDir, backupDir2, {
      syncRules: async () => {},
    });
    const upgraded = JSON.parse(fs.readFileSync(path.join(installedDir, 'plugin.json'), 'utf8'));
    assert.equal(upgraded.version, '1.3.0');
    assert.equal(fs.existsSync(path.join(panelDir, 'main.mjs')), true);
    assert.equal(fs.existsSync(path.join(panelDir, 'added.txt')), true);
    assert.equal(fs.existsSync(path.join(panelDir, 'obsolete.txt')), false);
  } finally {
    if (holder) {
      holder.kill();
      await new Promise((resolve) => holder.once('exit', resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
