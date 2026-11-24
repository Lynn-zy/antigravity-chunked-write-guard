import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PLUGIN_NAME = 'chunked-write-guard';
const DEFAULT_GITHUB_REPO = 'Lynn-zy/antigravity-chunked-write-guard';
const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
const CHECK_COOLDOWN_MS = 15_000;
const PLAN_TTL_MS = 15 * 60_000;

const ALLOWED_DOWNLOAD_HOSTS = Object.freeze([
  'api.github.com',
  'codeload.github.com',
  'github.com',
  'objects.githubusercontent.com',
]);

export const RUNTIME_ENTRIES = Object.freeze([
  'plugin.json',
  'hooks.json',
  'CHANGELOG.md',
  'assets',
  'rules',
  'scripts',
  'sidecars',
]);

const REQUIRED_FILES = Object.freeze([
  'plugin.json',
  'hooks.json',
  'CHANGELOG.md',
  'assets/logo.svg',
  'rules/AGENTS.md',
  'scripts/presets.mjs',
  'scripts/stats.mjs',
  'scripts/hook-core.mjs',
  'scripts/write-guard-hook.mjs',
  'sidecars/panel/sidecar.json',
  'sidecars/panel/main.mjs',
  'sidecars/panel/panel-logic.mjs',
  'sidecars/panel/updater.mjs',
  'sidecars/panel/index.html',
]);

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const GITHUB_REPO_RE = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git|\/|$)/i;
const REQUEST_HEADERS = Object.freeze({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'chunked-write-guard-updater',
});

/**
 * 解析严格稳定版语义化版本号（X.Y.Z，可带前缀 v），拒绝预发布与非法格式。
 * @param {unknown} raw - 原始版本字符串
 * @returns {{ major: number, minor: number, patch: number, normalized: string } | null} 解析结果
 */
export const parseSemver = (raw) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const match = SEMVER_RE.exec(raw.trim());
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { major, minor, patch, normalized: `${major}.${minor}.${patch}` };
};

/**
 * 比较两个稳定版语义化版本号的大小。
 * @param {string} left - 左侧版本号
 * @param {string} right - 右侧版本号
 * @returns {number} left > right 返回 1，相等返回 0，否则返回 -1
 */
export const compareSemver = (left, right) => {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    throw new Error(`Invalid semver comparison: "${left}" vs "${right}"`);
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) {
      return a[key] > b[key] ? 1 : -1;
    }
  }
  return 0;
};

const extractGithubRepo = (manifest) => {
  const candidates = [
    typeof manifest?.repository === 'string' ? manifest.repository : manifest?.repository?.url,
    manifest?.homepage,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const match = GITHUB_REPO_RE.exec(raw);
    if (match) return match[1];
  }
  return DEFAULT_GITHUB_REPO;
};

const sanitizeReleaseNotes = (text) => {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n/g, '\n').trim().slice(0, 8000);
};

/**
 * 读取并校验本地已安装插件的 plugin.json 清单。
 * @param {string} pluginDir - 插件根目录路径
 * @returns {{ name: string, version: string, repo: string }} 校验后的清单摘要
 */
export const readInstalledManifest = (pluginDir) => {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (parsed?.name !== PLUGIN_NAME) {
    throw new Error(`插件清单名称不匹配：期望 "${PLUGIN_NAME}"，实际 "${parsed?.name ?? ''}"`);
  }
  const semver = parseSemver(parsed?.version);
  if (!semver) {
    throw new Error(`插件清单版本号无效："${parsed?.version ?? ''}"`);
  }
  return {
    name: PLUGIN_NAME,
    version: semver.normalized,
    repo: extractGithubRepo(parsed),
  };
};

const fetchWithTimeout = async (url, { fetchImpl = fetch, timeoutMs = 15_000, headers = REQUEST_HEADERS } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('请求 GitHub 超时，请检查网络连接后重试');
    }
    throw new Error(`无法连接 GitHub：${err?.message ?? '网络错误'}`);
  } finally {
    clearTimeout(timer);
  }
};

const classifyHttpError = (status, label) => {
  if (status === 403 || status === 429) {
    return new Error('GitHub API 请求频率受限，请稍后再试');
  }
  return new Error(`${label}失败（HTTP ${status}）`);
};

const isRateLimitStatus = (status) => status === 403 || status === 429;

const buildArchiveTarballUrl = (repo, tagName) =>
  `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tagName)}.tar.gz`;

const preferArchiveTarballUrl = (repo, tagName, candidateUrl) => {
  // 优先走 github.com/archive -> codeload，避免下载阶段消耗 api.github.com 匿名限额
  if (typeof candidateUrl === 'string' && candidateUrl && !candidateUrl.startsWith('https://api.github.com/')) {
    return candidateUrl;
  }
  return buildArchiveTarballUrl(repo, tagName);
};

const pickHighestStableTag = (repo, tagItems) => {
  let best = null;
  for (const item of tagItems) {
    const tagName = typeof item === 'string' ? item : item?.name;
    const semver = parseSemver(tagName);
    if (!semver) continue;
    if (!best || compareSemver(semver.normalized, best.version) > 0) {
      best = {
        version: semver.normalized,
        tagName: String(tagName),
        tarballUrl: preferArchiveTarballUrl(repo, String(tagName), item?.tarball_url),
        releaseUrl: `https://github.com/${repo}/releases/tag/${tagName}`,
        releaseNotes: '',
        publishedAt: null,
        source: 'tag',
      };
    }
  }
  if (!best) {
    throw new Error('远端仓库暂未发现可用的稳定版本标签');
  }
  return best;
};

const extractChangelogSection = (markdown, version) => {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (startIdx === -1) return '';
  const nextIdx = lines.findIndex((line, i) => i > startIdx && line.startsWith('## ['));
  return sanitizeReleaseNotes(
    lines.slice(startIdx + 1, nextIdx === -1 ? lines.length : nextIdx).join('\n'),
  );
};

const fetchChangelogNotes = async ({ repo, tagName, version, fetchImpl, timeoutMs }) => {
  try {
    const res = await fetchWithTimeout(
      `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tagName)}/CHANGELOG.md`,
      {
        fetchImpl,
        timeoutMs: Math.min(timeoutMs, 8_000),
        headers: { 'User-Agent': 'chunked-write-guard-updater' },
      },
    );
    if (!res.ok || typeof res.text !== 'function') return '';
    return extractChangelogSection(await res.text(), version);
  } catch {
    return '';
  }
};

const fetchPublicFallback = async ({ repo, fetchImpl, timeoutMs }) => {
  let result = null;
  const latestPageRes = await fetchWithTimeout(
    `https://github.com/${repo}/releases/latest`,
    { fetchImpl, timeoutMs, headers: { 'User-Agent': 'chunked-write-guard-updater' } },
  );
  await latestPageRes.body?.cancel?.().catch(() => {});
  if (latestPageRes.ok && typeof latestPageRes.url === 'string') {
    const prefix = `/${repo}/releases/tag/`;
    const parsedUrl = new URL(latestPageRes.url);
    if (parsedUrl.hostname === 'github.com' && parsedUrl.pathname.startsWith(prefix)) {
      const tagName = decodeURIComponent(parsedUrl.pathname.slice(prefix.length));
      const semver = parseSemver(tagName);
      if (semver) {
        result = {
          version: semver.normalized,
          tagName,
          tarballUrl: buildArchiveTarballUrl(repo, tagName),
          releaseUrl: `https://github.com/${repo}/releases/tag/${tagName}`,
          releaseNotes: '',
          publishedAt: null,
          source: 'release',
        };
      }
    }
  }

  if (!result) {
    const atomRes = await fetchWithTimeout(
      `https://github.com/${repo}/tags.atom`,
      { fetchImpl, timeoutMs, headers: { 'User-Agent': 'chunked-write-guard-updater' } },
    );
    if (!atomRes.ok) {
      throw classifyHttpError(atomRes.status, '读取公开标签订阅');
    }
    const xml = await atomRes.text();
    const tagNames = Array.from(xml.matchAll(/\/releases\/tag\/([^"'<\s]+)/g), (m) => m[1]);
    result = pickHighestStableTag(repo, tagNames);
  }

  result.releaseNotes = await fetchChangelogNotes({
    repo,
    tagName: result.tagName,
    version: result.version,
    fetchImpl,
    timeoutMs,
  });
  return result;
};

/**
 * 查询远端最新稳定版本：优先读取 GitHub Releases，无 Release 回退至 Tags，API 限流时自动回退公开页面通道。
 * @param {{ repo?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options] - 查询参数与测试注入项
 * @returns {Promise<{ version: string, tagName: string, tarballUrl: string, releaseUrl: string, releaseNotes: string, publishedAt: string | null, source: 'release' | 'tag' }>} 最新版本信息
 */
export const fetchLatestReleaseInfo = async (options = {}) => {
  const repo = options.repo || DEFAULT_GITHUB_REPO;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const latestRes = await fetchWithTimeout(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { fetchImpl, timeoutMs },
  );

  if (latestRes.ok) {
    const data = await latestRes.json();
    const semver = parseSemver(data?.tag_name);
    if (semver) {
      const tagName = String(data.tag_name);
      return {
        version: semver.normalized,
        tagName,
        tarballUrl: preferArchiveTarballUrl(repo, tagName, data?.tarball_url),
        releaseUrl:
          typeof data.html_url === 'string' && data.html_url
            ? data.html_url
            : `https://github.com/${repo}/releases/tag/${tagName}`,
        releaseNotes: sanitizeReleaseNotes(data.body),
        publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
        source: 'release',
      };
    }
  } else if (isRateLimitStatus(latestRes.status)) {
    return fetchPublicFallback({ repo, fetchImpl, timeoutMs });
  } else if (latestRes.status !== 404) {
    throw classifyHttpError(latestRes.status, '检查更新');
  }

  const tagsRes = await fetchWithTimeout(
    `https://api.github.com/repos/${repo}/tags?per_page=30`,
    { fetchImpl, timeoutMs },
  );
  if (isRateLimitStatus(tagsRes.status)) {
    return fetchPublicFallback({ repo, fetchImpl, timeoutMs });
  }
  if (!tagsRes.ok) {
    throw classifyHttpError(tagsRes.status, '读取标签列表');
  }
  const tags = await tagsRes.json();
  if (!Array.isArray(tags)) {
    throw new Error('GitHub 标签响应格式异常');
  }
  return pickHighestStableTag(repo, tags);
};

const assertAllowedDownloadUrl = (rawUrl, allowedHosts) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('下载地址格式非法');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`拒绝使用非 HTTPS 下载地址：${parsed.protocol}`);
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new Error(`拒绝从非白名单主机下载：${parsed.hostname}`);
  }
};

/**
 * 流式下载更新包至指定路径，强制校验 HTTPS、主机白名单与体积上限，并实时汇报进度。
 * @param {string} url - 下载地址
 * @param {string} destPath - 本地保存路径
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, allowedHosts?: readonly string[], onProgress?: (progress: { downloadedBytes: number, totalBytes: number, percent: number | null }) => void }} [options] - 下载配置
 * @returns {Promise<{ bytes: number }>} 实际写入字节数
 */
export const downloadTarball = async (url, destPath, options = {}) => {
  const allowedHosts = options.allowedHosts ?? ALLOWED_DOWNLOAD_HOSTS;
  const maxBytes = options.maxBytes ?? MAX_TARBALL_BYTES;
  assertAllowedDownloadUrl(url, allowedHosts);

  const res = await fetchWithTimeout(url, {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 60_000,
    headers: { 'User-Agent': 'chunked-write-guard-updater' },
  });
  if (!res.ok) {
    throw classifyHttpError(res.status, '下载更新包');
  }
  if (res.url) {
    assertAllowedDownloadUrl(res.url, allowedHosts);
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  if (totalBytes > maxBytes) {
    throw new Error(`更新包体积超出安全上限（${Math.round(maxBytes / 1024 / 1024)} MB）`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error('下载响应缺少可读数据流');
  }

  const chunks = [];
  let downloadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    downloadedBytes += value.byteLength;
    if (downloadedBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`更新包体积超出安全上限（${Math.round(maxBytes / 1024 / 1024)} MB）`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    const percent =
      totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null;
    options.onProgress?.({ downloadedBytes, totalBytes, percent });
  }

  // 在体积上限内整包校验完成后一次性落盘，避免 Windows 下流写入异常导致清理 EBUSY
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.concat(chunks, downloadedBytes));
  return { bytes: downloadedBytes };
};

const assertNoSymlinkEscape = (baseDir, entryPath) => {
  const resolvedBase = path.resolve(baseDir);
  const resolvedEntry = path.resolve(entryPath);
  if (
    resolvedEntry !== resolvedBase &&
    !resolvedEntry.startsWith(`${resolvedBase}${path.sep}`)
  ) {
    throw new Error(`更新包包含越界路径：${entryPath}`);
  }
  const stat = fs.lstatSync(resolvedEntry);
  if (stat.isSymbolicLink()) {
    throw new Error(`更新包包含不允许的符号链接：${path.relative(resolvedBase, resolvedEntry)}`);
  }
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(resolvedEntry)) {
      assertNoSymlinkEscape(resolvedBase, path.join(resolvedEntry, child));
    }
  }
};

const defaultRunTar = async (tarballPath, extractDir) => {
  try {
    await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir], {
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(`解压更新包失败：${err?.stderr?.trim() || err?.message || 'tar 执行异常'}`);
  }
};

/**
 * 解压更新包并校验结构完整性、符号链接安全以及 plugin.json 名称与目标版本。
 * @param {string} tarballPath - 已下载的 .tar.gz 路径
 * @param {string} extractDir - 临时解压目录
 * @param {string} expectedVersion - 期望安装的版本号（X.Y.Z）
 * @param {{ runTar?: (tarballPath: string, extractDir: string) => Promise<void> }} [options] - 可选解压函数注入
 * @returns {Promise<{ sourceRoot: string, version: string }>} 校验通过的源码根目录与版本号
 */
export const extractAndVerifyTarball = async (
  tarballPath,
  extractDir,
  expectedVersion,
  options = {},
) => {
  const expected = parseSemver(expectedVersion);
  if (!expected) {
    throw new Error(`目标版本号无效："${expectedVersion}"`);
  }

  fs.mkdirSync(extractDir, { recursive: true });
  const runTar = options.runTar ?? defaultRunTar;
  await runTar(tarballPath, extractDir);

  let sourceRoot = extractDir;
  if (!fs.existsSync(path.join(extractDir, 'plugin.json'))) {
    const dirs = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    if (dirs.length !== 1) {
      throw new Error('更新包目录结构异常：未找到唯一的顶层插件目录');
    }
    sourceRoot = path.join(extractDir, dirs[0].name);
  }

  for (const entry of RUNTIME_ENTRIES) {
    const candidate = path.join(sourceRoot, entry);
    if (!fs.existsSync(candidate)) {
      throw new Error(`更新包缺少必需目录或文件：${entry}`);
    }
    assertNoSymlinkEscape(sourceRoot, candidate);
  }

  for (const relPath of REQUIRED_FILES) {
    const fullPath = path.join(sourceRoot, relPath);
    if (!fs.existsSync(fullPath) || !fs.lstatSync(fullPath).isFile()) {
      throw new Error(`更新包缺少必需文件：${relPath}`);
    }
  }

  const manifest = readInstalledManifest(sourceRoot);
  if (manifest.version !== expected.normalized) {
    throw new Error(
      `更新包版本不匹配：期望 v${expected.normalized}，实际 v${manifest.version}`,
    );
  }

  return { sourceRoot, version: manifest.version };
};

const defaultSyncRules = async (targetDir) => {
  const presetsUrl = pathToFileURL(path.join(targetDir, 'scripts', 'presets.mjs')).href;
  const script = `import(${JSON.stringify(presetsUrl)}).then((m) => { const cur = m.readActivePresetState(); m.applyPreset(cur.presetId, { reminderEnabled: cur.reminderEnabled }); })`;
  await execFileAsync(process.execPath, ['-e', script], {
    cwd: os.tmpdir(),
    timeout: 10_000,
    windowsHide: true,
  });
};

const collectRuntimeFiles = (rootDir) => {
  const files = [];
  const walk = (relPath) => {
    const absPath = path.join(rootDir, relPath);
    if (!fs.existsSync(absPath)) return;
    const stat = fs.lstatSync(absPath);
    if (stat.isFile()) {
      files.push(relPath.split(path.sep).join('/'));
      return;
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absPath)) {
        walk(path.join(relPath, child));
      }
    }
  };
  for (const entry of RUNTIME_ENTRIES) {
    walk(entry);
  }
  return files.sort();
};

const copyFileInPlace = (srcPath, dstPath) => {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.copyFileSync(srcPath, dstPath);
};

/**
 * 按文件级就地备份并替换插件运行时文件（永不删除稳定目录、不触碰 config/），失败时幂等回滚。
 * @param {string} sourceRoot - 已校验的新版本根目录
 * @param {string} targetDir - 本地已安装插件根目录
 * @param {string} backupDir - 临时备份目录
 * @param {{ syncRules?: (targetDir: string) => Promise<void>, onPhase?: (phase: string) => void }} [options] - 回调与测试注入
 * @returns {Promise<void>}
 */
export const swapRuntimeEntries = async (sourceRoot, targetDir, backupDir, options = {}) => {
  const syncRules = options.syncRules ?? defaultSyncRules;
  const onPhase = options.onPhase ?? (() => {});

  onPhase('backup');
  const oldFiles = collectRuntimeFiles(targetDir);
  const newFiles = collectRuntimeFiles(sourceRoot);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const relPath of oldFiles) {
    copyFileInPlace(path.join(targetDir, relPath), path.join(backupDir, relPath));
  }

  onPhase('install');
  const newKeySet = new Set(newFiles.map((item) => item.toLowerCase()));
  const oldKeySet = new Set(oldFiles.map((item) => item.toLowerCase()));
  try {
    // Windows 下宿主可能持有 sidecars/panel 等目录句柄，按文件就地覆写而不删除目录本身
    for (const relPath of newFiles) {
      copyFileInPlace(path.join(sourceRoot, relPath), path.join(targetDir, relPath));
    }
    for (const relPath of oldFiles) {
      if (!newKeySet.has(relPath.toLowerCase())) {
        fs.rmSync(path.join(targetDir, relPath), { force: true });
      }
    }
    await syncRules(targetDir);
  } catch (installErr) {
    onPhase('recover');
    try {
      for (const relPath of oldFiles) {
        copyFileInPlace(path.join(backupDir, relPath), path.join(targetDir, relPath));
      }
      for (const relPath of newFiles) {
        if (!oldKeySet.has(relPath.toLowerCase())) {
          fs.rmSync(path.join(targetDir, relPath), { force: true });
        }
      }
    } catch (rollbackErr) {
      throw new Error(
        `安装失败（${installErr.message}），回滚亦失败（${rollbackErr.message}）`,
      );
    }
    throw new Error(`安装失败并已回滚至原版本：${installErr.message}`);
  }
};

const VALID_ACTIONS = new Set(['check', 'status', 'apply', 'reload']);
const ALLOWED_BODY_KEYS = new Set(['action', 'version']);

/**
 * 面板内更新状态机，管理手动检查、下载安装与 Sidecar 重载流程。
 */
export class PluginUpdater {
  constructor(options) {
    this.pluginDir = options.pluginDir;
    this.onReload = options.onReload ?? (() => {});
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.allowedHosts = options.allowedHosts ?? ALLOWED_DOWNLOAD_HOSTS;
    this.runTar = options.runTar;
    this.syncRules = options.syncRules;
    this.now = options.now ?? (() => Date.now());
    this.cooldownMs = options.cooldownMs ?? CHECK_COOLDOWN_MS;
    this.planTtlMs = options.planTtlMs ?? PLAN_TTL_MS;
    this.reloadDelayMs = options.reloadDelayMs ?? 250;

    this.plan = null;
    this.lastCheckedAt = 0;
    this.activeTask = null;
    this.state = {
      status: 'idle',
      phase: '',
      currentVersion: this.#safeReadVersion(),
      latestVersion: null,
      releaseUrl: null,
      releaseNotes: '',
      source: null,
      download: null,
      message: '',
      error: null,
    };
  }

  #safeReadVersion() {
    try {
      return readInstalledManifest(this.pluginDir).version;
    } catch {
      return '0.0.0';
    }
  }

  #snapshot() {
    return {
      ...this.state,
      download: this.state.download ? { ...this.state.download } : null,
    };
  }

  /**
   * 校验并分发面板提交的更新请求（check / status / apply / reload）。
   * @param {unknown} body - 请求体 JSON
   * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, status: number, error: string }} 执行结果
   */
  request(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, status: 400, error: '请求体必须是 JSON 对象' };
    }
    for (const key of Object.keys(body)) {
      if (!ALLOWED_BODY_KEYS.has(key)) {
        return { ok: false, status: 400, error: `不支持的请求字段："${key}"` };
      }
    }
    const action = body.action;
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
      return { ok: false, status: 400, error: `不支持的更新操作："${String(action ?? '')}"` };
    }

    if (action === 'status') {
      return { ok: true, state: this.#snapshot() };
    }
    if (action === 'check') {
      return { ok: true, state: this.#startCheck() };
    }
    if (action === 'apply') {
      return this.#startApply(body.version);
    }
    return this.#startReload();
  }

  /**
   * 等待当前异步检查或安装任务完成（主要用于测试）。
   * @returns {Promise<Record<string, unknown>>} 任务结束后的状态快照
   */
  async waitForIdle() {
    if (this.activeTask) {
      await this.activeTask;
    }
    return this.#snapshot();
  }

  #startCheck() {
    const lockedStates = new Set(['checking', 'installing', 'installed', 'reloading']);
    if (lockedStates.has(this.state.status)) {
      return this.#snapshot();
    }
    const elapsed = this.now() - this.lastCheckedAt;
    if (
      this.state.status !== 'idle' &&
      this.state.status !== 'error' &&
      this.lastCheckedAt > 0 &&
      elapsed < this.cooldownMs
    ) {
      return this.#snapshot();
    }

    this.state = {
      ...this.state,
      status: 'checking',
      phase: 'check',
      download: null,
      message: '正在检查 GitHub 最新版本…',
      error: null,
    };

    this.activeTask = this.#runCheck().finally(() => {
      this.activeTask = null;
    });
    return this.#snapshot();
  }

  async #runCheck() {
    try {
      const manifest = readInstalledManifest(this.pluginDir);
      const latest = await fetchLatestReleaseInfo({
        repo: manifest.repo,
        fetchImpl: this.fetchImpl,
      });
      this.lastCheckedAt = this.now();

      const hasUpdate = compareSemver(latest.version, manifest.version) > 0;
      if (!hasUpdate) {
        this.plan = null;
        this.state = {
          status: 'current',
          phase: 'complete',
          currentVersion: manifest.version,
          latestVersion: latest.version,
          releaseUrl: latest.releaseUrl,
          releaseNotes: latest.releaseNotes,
          source: latest.source,
          download: null,
          message: `当前已是最新版本（v${manifest.version}）`,
          error: null,
        };
        return;
      }

      this.plan = {
        ...latest,
        createdAt: this.now(),
      };
      this.state = {
        status: 'available',
        phase: 'complete',
        currentVersion: manifest.version,
        latestVersion: latest.version,
        releaseUrl: latest.releaseUrl,
        releaseNotes: latest.releaseNotes,
        source: latest.source,
        download: null,
        message: `发现新版本 v${latest.version}（当前 v${manifest.version}）`,
        error: null,
      };
    } catch (err) {
      this.plan = null;
      this.state = {
        ...this.state,
        status: 'error',
        phase: 'check',
        download: null,
        message: '检查更新失败',
        error: err?.message ?? '未知错误',
      };
    }
  }

  #startApply(requestedVersion) {
    if (this.state.status === 'installing' || this.state.status === 'reloading') {
      return { ok: true, state: this.#snapshot() };
    }
    if (this.state.status !== 'available' || !this.plan) {
      return { ok: false, status: 400, error: '当前没有可安装的更新，请先点击检查更新' };
    }
    if (this.now() - this.plan.createdAt > this.planTtlMs) {
      this.plan = null;
      this.state = { ...this.state, status: 'idle', phase: '', message: '' };
      return { ok: false, status: 400, error: '更新检查结果已过期，请重新检查更新' };
    }
    if (
      requestedVersion !== undefined &&
      parseSemver(requestedVersion)?.normalized !== this.plan.version
    ) {
      return { ok: false, status: 400, error: '请求的目标版本与最新检查结果不一致' };
    }

    const plan = this.plan;
    this.state = {
      ...this.state,
      status: 'installing',
      phase: 'download',
      download: { downloadedBytes: 0, totalBytes: 0, percent: null },
      message: `正在下载 v${plan.version}…`,
      error: null,
    };

    this.activeTask = this.#runInstall(plan).finally(() => {
      this.activeTask = null;
    });
    return { ok: true, state: this.#snapshot() };
  }

  async #runInstall(plan) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunked-write-guard-update-'));
    const tarballPath = path.join(tempDir, `v${plan.version}.tar.gz`);
    const extractDir = path.join(tempDir, 'extracted');
    const backupDir = path.join(tempDir, 'backup');

    try {
      await downloadTarball(plan.tarballUrl, tarballPath, {
        fetchImpl: this.fetchImpl,
        allowedHosts: this.allowedHosts,
        onProgress: (progress) => {
          this.state.download = progress;
        },
      });

      this.state.phase = 'verify';
      this.state.message = `正在校验 v${plan.version} 更新包…`;
      const { sourceRoot } = await extractAndVerifyTarball(
        tarballPath,
        extractDir,
        plan.version,
        { runTar: this.runTar },
      );

      await swapRuntimeEntries(sourceRoot, this.pluginDir, backupDir, {
        syncRules: this.syncRules,
        onPhase: (phase) => {
          this.state.phase = phase;
          if (phase === 'backup') this.state.message = '正在备份当前版本…';
          if (phase === 'install') this.state.message = `正在替换插件文件并同步规则…`;
          if (phase === 'recover') this.state.message = '安装异常，正在自动回滚…';
        },
      });

      this.plan = null;
      this.state = {
        ...this.state,
        status: 'installed',
        phase: 'complete',
        currentVersion: plan.version,
        latestVersion: plan.version,
        download: null,
        message: `已更新至 v${plan.version}`,
        error: null,
      };
    } catch (err) {
      this.state = {
        ...this.state,
        status: 'error',
        download: null,
        message: '更新安装失败',
        error: err?.message ?? '未知错误',
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  #startReload() {
    if (this.state.status === 'reloading') {
      return { ok: true, state: this.#snapshot() };
    }
    if (this.state.status !== 'installed') {
      return { ok: false, status: 400, error: '尚未完成新版本安装，无需重新加载' };
    }
    this.state = {
      ...this.state,
      status: 'reloading',
      phase: 'complete',
      message: '正在重启面板服务并加载新版本…',
      error: null,
    };
    setTimeout(() => {
      this.onReload();
    }, this.reloadDelayMs);
    return { ok: true, state: this.#snapshot() };
  }
}
