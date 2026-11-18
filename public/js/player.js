/**
 * 播放器层：适配车载大屏触摸（含断点记忆、自动续播与直播超时熔断）
 * 统一播放引擎（tesla-media-hub 内置播放库，基于 wody11/Tesla-VideoPlayer）：
 *   - 完全无 <video> 标签，纯 WebCodecs 解码 → Canvas 渲染
 *   - AppleCMS 点播：浏览器直连源站 HLS/MP4（不走服务端，零服务器负载）
 *   - IPTV 直播：直连优先 + 8 秒首帧超时自动回退代理与多线路切换
 *   - 源站不支持 WebCodecs 或跨域受限时给出提示
 */

const playerLayer = document.getElementById('player-layer');
let iptvPlayer = null;       // 统一播放实例（tesla-media-hub 内置播放库），承载 IPTV 直播与 AppleCMS 点播
let playCtx = null;          // AppleCMS 点播上下文：{ siteKey, vodName, plays, flagIdx, curEp, qualityIdx, urls, lastUrl, isLastEp }
let startupTimer = null;     // 首帧超时诊断定时器
let iptvSessionId = 0;       // 直播会话令牌：防止快速切台或关闭播放器后异步实例残留窜台
let lastFramePaused = false; // 末集/单集：已在最后一秒暂停画面，避免重复暂停与误触发续播
const LAST_FRAME_PAUSE_SEC = 1; // 距离片尾不足该秒数时暂停在末帧

// ==================== 断点续播存储模块 ====================
const VOD_HISTORY_KEY = 'tesla_vod_history_v1';
const VOD_HISTORY_MAX = 15;
let lastHistorySaveTs = 0;

function getVodHistoryKey(ctx) {
  if (!ctx) return '';
  if (ctx.directPlay) return 'webdav::' + (ctx.vodName || '');
  return (ctx.siteKey || 'default') + '::' + (ctx.vodId || ctx.vodName || '');
}

function getAllVodHistory() {
  try {
    return JSON.parse(localStorage.getItem(VOD_HISTORY_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function getVodHistoryItem(ctx) {
  const key = getVodHistoryKey(ctx);
  if (!key) return null;
  return getAllVodHistory().find(item => item.key === key) || null;
}

function formatDurationSec(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function saveVodProgress(ctx, currentTime, duration, force = false) {
  if (!ctx || !ctx.vodName) return;
  const now = Date.now();
  if (!force && now - lastHistorySaveTs < 5000) return;
  lastHistorySaveTs = now;

  const t = Math.floor(currentTime || 0);
  const d = Math.floor(duration || 0);
  // 播放不足 5 秒不覆盖已有进度（防止刚打开未 seek 前的 0 秒覆盖旧记录）
  if (t < 5 && !force) return;

  const key = getVodHistoryKey(ctx);
  const flag = (ctx.plays && ctx.plays[ctx.flagIdx]) || {};
  const ep = (flag.episodes || [])[ctx.curEp] || {};
  const epName = ep.name || ('第' + (ctx.curEp + 1) + '集');

  // 若本集剩余不足 15 秒，自动将续播点推进到下一集开头
  let saveEp = ctx.curEp;
  let saveTime = t;
  let saveEpName = epName;
  const eps = flag.episodes || [];
  if (d > 0 && d - t <= 15) {
    if (ctx.curEp + 1 < eps.length) {
      saveEp = ctx.curEp + 1;
      saveTime = 0;
      saveEpName = (eps[saveEp] && eps[saveEp].name) || ('第' + (saveEp + 1) + '集');
    } else {
      saveTime = 0; // 已全部看完，下次从头看
    }
  }

  let list = getAllVodHistory().filter(item => item.key !== key);
  list.unshift({
    key,
    siteKey: ctx.siteKey || '',
    vodId: ctx.vodId || '',
    vodName: ctx.vodName,
    poster: ctx.poster || '',
    plays: ctx.plays || [],
    flagIdx: ctx.flagIdx || 0,
    curEp: saveEp,
    epName: saveEpName,
    time: saveTime,
    duration: d,
    directPlay: !!ctx.directPlay,
    updatedAt: now
  });

  if (list.length > VOD_HISTORY_MAX) list = list.slice(0, VOD_HISTORY_MAX);
  try {
    localStorage.setItem(VOD_HISTORY_KEY, JSON.stringify(list));
  } catch (e) { /* 存储满时忽略 */ }
}
// =========================================================

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 将第三方播放地址改写为同源流媒体代理地址，绕过源站防盗链 / 跨域限制。
 */
function proxyUrl(raw) {
  if (!raw) return raw;
  if (/^(blob:|data:)/i.test(raw)) return raw;
  const origin = (typeof window !== 'undefined' && window.location && window.location.origin) || '';
  if (raw.indexOf('/api/stream') !== -1) {
    if (/^https?:\/\//i.test(raw)) return raw;
    return origin + raw;
  }
  if (/^https?:\/\//i.test(raw)) return origin + '/api/stream?url=' + encodeURIComponent(raw);
  return raw;
}

async function openPlayer(ctx) {
  // 点击影片进入播放时自动请求网页全屏
  try {
    const elem = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(() => {});
      } else if (elem.webkitRequestFullscreen) {
        elem.webkitRequestFullscreen();
      }
    }
  } catch (e) { /* ignore */ }

  iptvSessionId++; // 作废可能正在异步初始化的直播会话

  // 销毁可能存在的播放实例
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }

  // 查询历史观看记录，自动恢复集数与断点时间
  const saved = getVodHistoryItem(ctx);
  let targetFlagIdx = ctx.flagIdx || 0;
  let targetEp = ctx.startEp;
  let pendingSeekTime = ctx.resumeTime || 0;

  if (saved) {
    // 若调用方未指定具体集数（如从搜索/列表点击影片进入），自动恢复上次观看的线路与集数
    if (targetEp === undefined || targetEp === null) {
      if (ctx.plays && ctx.plays[saved.flagIdx]) {
        targetFlagIdx = saved.flagIdx;
      }
      targetEp = saved.curEp || 0;
      if (!pendingSeekTime && saved.time > 5) {
        pendingSeekTime = saved.time;
      }
    } else if (targetEp === saved.curEp && !pendingSeekTime && saved.time > 5) {
      // 若点击的正好是上次观看的那一集，同样自动定位到断点
      pendingSeekTime = saved.time;
    }
  }

  playCtx = {
    ...ctx,
    flagIdx: targetFlagIdx,
    curEp: targetEp || 0,
    qualityIdx: -1,
    urls: [],
    lastUrl: '',
    _pendingSeek: pendingSeekTime,
    _curTime: 0,
    _duration: 0,
  };

  playerLayer.classList.remove('hidden');
  renderEpStrip();
  await playCurrent(pendingSeekTime > 5);
}

/**
 * 打开 IPTV 频道播放（支持自动全屏 + 直连优先 + 8 秒首帧超时熔断 + 多线路自动容错切换）
 */
async function openIptvPlayer(ctx, isFallback = false) {
  const mySession = ++iptvSessionId;

  try {
    const elem = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(() => {});
      } else if (elem.webkitRequestFullscreen) {
        elem.webkitRequestFullscreen();
      }
    }
  } catch (e) { /* ignore */ }

  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }
  playCtx = null;

  try { document.getElementById('ep-strip').innerHTML = ''; } catch (e) { /* ignore */ }

  const driveView = document.getElementById('drive-view');
  const iptvView = document.getElementById('iptv-view');
  const host = document.getElementById('iptv-host');
  const titleEl = document.getElementById('player-title');
  const qBtn = document.getElementById('btn-quality');

  titleEl.textContent = ctx.name || '电视直播';
  if (qBtn) qBtn.style.display = 'none';

  playerLayer.classList.remove('hidden');
  driveView.classList.add('hidden');
  iptvView.classList.remove('hidden');
  if (host) host.innerHTML = ''; // 清理上一台残留画面

  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }

  if (!window.IptvAdapter || !window.IptvAdapter.isSupported()) {
    showToast('当前浏览器不支持 WebCodecs');
    return;
  }

  const isHttp = /^http:\/\//i.test(ctx.streamUrl);
  const playUrl = (isFallback || isHttp) ? proxyUrl(ctx.streamUrl) : ctx.streamUrl;
  showToast('正在加载 ' + (ctx.name || '频道'));

  // 8 秒首帧超时熔断：防止海外直播源丢包导致无限转圈
  let settled = false;
  const triggerIptvFallbackOrNext = (reasonMsg) => {
    if (settled || mySession !== iptvSessionId) return;
    settled = true;
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (iptvPlayer) {
      try { iptvPlayer.destroy(); } catch (_) { /* ignore */ }
      iptvPlayer = null;
    }
    if (!isFallback && !isHttp) {
      showToast('直连超时，正在尝试代理通道拉流…');
      openIptvPlayer(ctx, true);
      return;
    }
    if (typeof ctx.onAllFailed === 'function') {
      ctx.onAllFailed();
      return;
    }
    showToast('直播加载失败：' + (reasonMsg || '频道暂无信号'));
  };

  startupTimer = setTimeout(() => {
    triggerIptvFallbackOrNext('连接超时');
  }, 8000);

  try {
    const player = await window.IptvAdapter.createPlayer(host, playUrl, {
      live: true,
      onFirstFrame: () => {
        if (settled || mySession !== iptvSessionId) return;
        settled = true;
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
        const t = document.getElementById('toast');
        if (t) t.classList.remove('show');
      },
      onStatus: (msg) => {
        if (!settled && mySession === iptvSessionId) showToast(msg);
      },
      onError: (e) => {
        triggerIptvFallbackOrNext(e && e.message);
      },
      onEnded: () => {
        if (mySession !== iptvSessionId) return;
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
        showToast('直播已结束');
      },
    });

    // 若播放器创建完成前用户已切台或触发超时，立即销毁迟到的实例
    if (settled || mySession !== iptvSessionId) {
      try { player && player.destroy(); } catch (_) { /* ignore */ }
      return;
    }
    iptvPlayer = player;
  } catch (e) {
    triggerIptvFallbackOrNext(e && e.message);
  }
}
window.openIptvPlayer = openIptvPlayer;

/**
 * 启动 AppleCMS 点播播放（tesla-media-hub 内置播放库，VOD 模式）
 */
async function applyMode() {
  const ctx = playCtx;
  if (!ctx) return;

  const driveView = document.getElementById('drive-view');
  const driveHost = document.getElementById('tesla-host');
  const iptvView = document.getElementById('iptv-view');

  iptvView.classList.add('hidden');
  driveView.classList.remove('hidden');
  driveHost.classList.remove('hidden');

  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }

  if (!window.IptvAdapter || !window.IptvAdapter.isSupported()) {
    showToast('当前浏览器不支持 WebCodecs');
    return;
  }

  ctx.lastUrl = ctx._fallback ? proxyUrl(ctx.rawUrl) : ctx.rawUrl;

  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  startupTimer = setTimeout(() => {
    startupTimer = null;
    showToast('首帧等待超时：该片源可能为车机不支持的编码（如 HEVC/H265）或解码缓慢，可尝试切换线路');
  }, 15000);

  try {
    iptvPlayer = await window.IptvAdapter.createPlayer(driveHost, ctx.lastUrl, {
      live: false,
      onFirstFrame: () => {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
        // 首帧解码渲染完成后，若存在历史断点则自动跳转
        if (playCtx && playCtx._pendingSeek > 5 && iptvPlayer) {
          const targetSec = playCtx._pendingSeek;
          playCtx._pendingSeek = 0;
          setTimeout(() => {
            try {
              if (iptvPlayer && typeof iptvPlayer.seek === 'function') {
                iptvPlayer.seek(targetSec);
                showToast(`已自动接续至 ${formatDurationSec(targetSec)}`);
              }
            } catch (err) { /* ignore */ }
          }, 250);
        }
      },
      onError: (e) => {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
        if (!ctx._fallback && !ctx._fallbackTried) {
          ctx._fallbackTried = true;
          ctx._fallback = true;
          showToast('直连受限，正在尝试代理通道拉流…');
          applyMode();
          return;
        }
        showToast('播放出错：' + (e && e.message ? e.message : '未知错误'));
      },
      // 时间更新：实时保存播放进度 + 末集停在末帧
      onTime: (currentTime, duration) => {
        const c = playCtx;
        if (!c) return;
        c._curTime = currentTime;
        c._duration = duration;

        // 每 5 秒自动记录一次当前剧集与秒数
        saveVodProgress(c, currentTime, duration, false);

        if (!c.isLastEp) return;
        if (lastFramePaused) return;
        if (!duration || duration <= 0) return;
        if (duration - currentTime <= LAST_FRAME_PAUSE_SEC) {
          lastFramePaused = true;
          saveVodProgress(c, currentTime, duration, true);
          try { iptvPlayer && iptvPlayer.pause(); } catch (_) { /* ignore */ }
          showToast('已播至本片结尾（末集）');
        }
      },
      // 播放结束：非末集自动续播下一集并更新记录；末集停在末帧
      onEnded: () => {
        const c = playCtx;
        if (!c) return;
        if (!c.isLastEp) {
          const next = c.curEp + 1;
          const epsLen = ((c.plays[c.flagIdx] || {}).episodes || []).length;
          if (next < epsLen) {
            showToast('自动播放下一集…');
            switchEp(next);
          }
        } else if (iptvPlayer && !lastFramePaused) {
          lastFramePaused = true;
          saveVodProgress(c, c._duration, c._duration, true);
          try { iptvPlayer.pause(); } catch (_) { /* ignore */ }
        }
      },
    });
  } catch (e) {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (!ctx._fallback && !ctx._fallbackTried) {
      ctx._fallbackTried = true;
      ctx._fallback = true;
      showToast('直连受限，正在尝试代理通道拉流…');
      applyMode();
      return;
    }
    showToast('播放失败（浏览器需支持 WebCodecs 且源站允许跨域）：' + (e && e.message ? e.message : ''));
  }
}

function renderEpStrip() {
  const ctx = playCtx;
  const flag = (ctx.plays[ctx.flagIdx] || {});
  const eps = flag.episodes || [];
  const strip = document.getElementById('ep-strip');
  strip.innerHTML = eps
    .map((e, i) => `<button class="ep-mini ${i === ctx.curEp ? 'active' : ''}" onclick="switchEp(${i})">${esc(e.name || '第' + (i + 1) + '集')}</button>`)
    .join('');
  const active = strip.querySelector('.ep-mini.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

async function switchEp(i) {
  const ctx = playCtx;
  if (!ctx) return;
  const eps = (ctx.plays[ctx.flagIdx] || {}).episodes || [];
  if (i < 0 || i >= eps.length) return;
  ctx.curEp = i;
  ctx._pendingSeek = 0; // 手动切换新集数时从 0 秒起播
  ctx._curTime = 0;
  saveVodProgress(ctx, 0, 0, true);
  renderEpStrip();
  await playCurrent();
}

async function playCurrent(resume) {
  const ctx = playCtx;
  const flag = ctx.plays[ctx.flagIdx] || {};
  const ep = (flag.episodes || [])[ctx.curEp];
  if (!ep) {
    showToast('该线路暂无选集');
    return;
  }
  const title = `${ctx.vodName} · ${ep.name || '第' + (ctx.curEp + 1) + '集'}`;
  document.getElementById('player-title').textContent = title;

  const eps = (flag.episodes || []);
  ctx.isLastEp = ctx.curEp >= eps.length - 1;
  lastFramePaused = false;

  // WebDAV / 直链播放
  if (ctx.directPlay) {
    const epUrl = ep.url || ep.id || '';
    if (!epUrl) { showToast('未获取到播放地址'); return; }
    ctx.rawUrl = epUrl;
    ctx._fallback = false;
    ctx._fallbackTried = false;
    ctx.lastUrl = ctx.rawUrl;
    ctx.urls = [{ label: '默认', url: epUrl }];
    ctx.qualityIdx = 0;
    const qBtn = document.getElementById('btn-quality');
    if (qBtn) qBtn.style.display = 'none';
    await applyMode();
    return;
  }

  let res;
  try {
    res = await api(
      `/api/sites/${encodeURIComponent(ctx.siteKey)}/play` +
      `?id=${encodeURIComponent(ep.id || ep.url || '')}`
    );
  } catch (e) {
    showToast('获取播放地址失败：' + e.message);
    return;
  }

  ctx.rawUrl = res.url || ep.url || ep.id || '';
  ctx._fallback = false;
  ctx._fallbackTried = false;
  ctx.lastUrl = ctx.rawUrl;
  ctx.urls = (res.urls && res.urls.length) ? res.urls : (res.url ? [{ label: res.label || '自动', url: res.url }] : []);
  if (!ctx.urls.length) {
    showToast('未获取到播放地址');
    return;
  }
  ctx.qualityIdx = ctx.urls.length - 1;

  const qBtn = document.getElementById('btn-quality');
  if (ctx.urls.length > 1) {
    qBtn.style.display = '';
    qBtn.textContent = ctx.urls[ctx.qualityIdx].label;
  } else {
    qBtn.style.display = 'none';
  }

  await applyMode();
}

async function cycleQuality() {
  const ctx = playCtx;
  if (!ctx.urls || ctx.urls.length < 2) return;
  // 切换清晰度时保留当前已播放的秒数
  if (ctx._curTime > 5) {
    ctx._pendingSeek = ctx._curTime;
  }
  ctx.qualityIdx = (ctx.qualityIdx + 1) % ctx.urls.length;
  const q = ctx.urls[ctx.qualityIdx];
  document.getElementById('btn-quality').textContent = q.label;
  ctx.rawUrl = q.url;
  ctx.lastUrl = q.url;
  ctx._fallback = false;
  ctx._fallbackTried = false;
  await applyMode();
  showToast('已切换：' + q.label);
}

function closePlayer() {
  iptvSessionId++; // 作废任何正在进行中的直播连接

  // 关闭播放器前强制保存最后一刻的观看进度
  if (playCtx && playCtx._curTime > 5) {
    saveVodProgress(playCtx, playCtx._curTime, playCtx._duration, true);
  }

  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }

  try {
    const driveHost = document.getElementById('tesla-host');
    const iptvHost = document.getElementById('iptv-host');
    if (driveHost) driveHost.innerHTML = '';
    if (iptvHost) iptvHost.innerHTML = '';
    document.getElementById('drive-view').classList.add('hidden');
    document.getElementById('iptv-view').classList.add('hidden');
  } catch (e) { /* ignore */ }

  try { document.getElementById('ep-strip').innerHTML = ''; } catch (e) { /* ignore */ }

  playCtx = null;
  lastFramePaused = false;
  playerLayer.classList.add('hidden');
}

// 一键接续最近一次观看的剧集/电影（供顶栏按钮或首页卡片调用）
function resumeLastWatch(index = 0) {
  const list = getAllVodHistory();
  const item = list[index];
  if (!item || !item.plays || !item.plays.length) {
    showToast('暂无历史观看记录');
    return;
  }
  openPlayer({
    siteKey: item.siteKey,
    vodId: item.vodId,
    vodName: item.vodName,
    poster: item.poster,
    plays: item.plays,
    flagIdx: item.flagIdx || 0,
    startEp: item.curEp || 0,
    resumeTime: item.time || 0,
    directPlay: !!item.directPlay,
  });
}

// WebDAV / 直链播放入口
function playWebdav(streamUrl, name) {
  openPlayer({
    vodName: name || 'WebDAV',
    poster: '',
    plays: [{ flag: 'WebDAV', episodes: [{ name: name || 'WebDAV', url: streamUrl }] }],
    flagIdx: 0,
    startEp: 0,
    directPlay: true,
  });
}
window.playWebdav = playWebdav;

// 暴露给 app.js 与页面按钮使用
window.openPlayer = openPlayer;
window.switchEp = switchEp;
window.cycleQuality = cycleQuality;
window.closePlayer = closePlayer;
window.resumeLastWatch = resumeLastWatch;
window.getAllVodHistory = getAllVodHistory;
