/**
 * 播放适配器（tesla-media-hub 内置播放库，基于 wody11/Tesla-VideoPlayer）
 */

let _mod = null;
let _modLoading = null;

function loadModule() {
  if (_mod) return Promise.resolve(_mod);
  if (!_modLoading) {
    _modLoading = import('/assets/guard-e6d89b7c.js')
      .then((m) => {
        _mod = m;
        return m;
      })
      .catch((e) => {
        _modLoading = null;
        throw e;
      });
  }
  return _modLoading;
}

function isSupported() {
  return (
    typeof window !== 'undefined' &&
    'VideoDecoder' in window &&
    'AudioDecoder' in window &&
    typeof window.Worker === 'function'
  );
}

const DECODE_PRESET_HARDWARE = 'hardware';
const DECODE_PRESET_SOFTWARE = 'software';
const FIRST_FRAME_TIMEOUT_MS = 15000;

async function createPlayer(hostEl, url, opts = {}) {
  if (!isSupported()) throw new Error('当前浏览器不支持 WebCodecs（播放所需）');

  // 1. 过滤任何非必要的代理包裹，确保默认以纯直连地址喂给内核
  if (url && typeof url === 'string' && url.includes('/api/stream?url=')) {
    const match = url.match(/[?&]url=([^&]+)/);
    if (match && match[1]) {
      url = decodeURIComponent(match[1]);
    }
  }

  const mod = await loadModule();
  const Player = mod.m || mod.default || mod.Player;
  if (typeof Player !== 'function') throw new Error('播放库未导出 Player');

  const live = opts.live !== false;
  const errorMsg = live ? '直播源无响应' : '片源无响应';

  let decodePresetId = DECODE_PRESET_HARDWARE;
  let player = null;
  let destroyed = false;
  let firstFrameOk = false;
  let fallbackTimer = null;

  function clearTimers() {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function destroy() {
    destroyed = true;
    clearTimers();
    const p = player;
    player = null;
    if (!p) return;
    try {
      const god = p.god;
      p.god = null;
      if (god && typeof god.destroy === 'function') god.destroy();
    } catch (_) { /* ignore */ }
    try {
      if (typeof p.destroy === 'function') p.destroy();
    } catch (_) { /* ignore */ }
    if (hostEl) hostEl.innerHTML = '';
  }

  async function start(fallback) {
    if (destroyed) return;
    if (fallback) decodePresetId = DECODE_PRESET_SOFTWARE;

    if (player) {
      try {
        if (typeof player.destroy === 'function') player.destroy();
      } catch (_) { /* ignore */ }
      player = null;
    }
    if (hostEl) hostEl.innerHTML = '';

    player = new Player({
      container: hostEl,
      loop: false,
      isLive: live,
      decodePresetId,
    });

    player.on('time', () => {
      if (!firstFrameOk) markFirstFrame();
      if (typeof opts.onTime === 'function') {
        let ct = 0, dur = 0;
        try { ct = player.currentTime || 0; } catch (_) { /* ignore */ }
        try { dur = player.duration || 0; } catch (_) { /* ignore */ }
        opts.onTime(ct, dur);
      }
    });
    player.on('firstVideoRendered', () => markFirstFrame());
    player.on('firstAudioRendered', () => markFirstFrame());
    player.on('ended', () => {
      if (typeof opts.onEnded === 'function') opts.onEnded();
    });

    // 显式捕获底层网络/解码异常
    player.on('error', (err) => {
      clearTimers();
      if (typeof opts.onError === 'function') {
        opts.onError(err || new Error('内核拉流异常'));
      }
    });

    function markFirstFrame() {
      if (firstFrameOk) return;
      firstFrameOk = true;
      clearTimers();
      if (typeof opts.onFirstFrame === 'function') opts.onFirstFrame();
    }

    try {
      const playPromise = player.loadSource(url, { isLive: live }, true);
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((e) => {
          clearTimers();
          if (typeof opts.onError === 'function') opts.onError(e);
        });
      }
    } catch (e) {
      clearTimers();
      if (typeof opts.onError === 'function') opts.onError(e);
      return;
    }

    fallbackTimer = setTimeout(() => {
      if (destroyed || firstFrameOk) return;
      if (decodePresetId === DECODE_PRESET_HARDWARE && !fallback) {
        if (typeof opts.onStatus === 'function') {
          opts.onStatus('硬解无响应，切换兼容模式…');
        }
        start(true);
      } else if (typeof opts.onError === 'function') {
        opts.onError(new Error(errorMsg));
      }
    }, FIRST_FRAME_TIMEOUT_MS);
  }

  await start(false);

  return {
    destroy,
    pause() {
      if (player && typeof player.pause === 'function') {
        try { player.pause(); } catch (_) { /* ignore */ }
      }
    },
    getCurrentTime() {
      try { return player ? (player.currentTime || 0) : 0; } catch (_) { return 0; }
    },
    getDuration() {
      try { return player ? (player.duration || 0) : 0; } catch (_) { return 0; }
    },
  };
}

window.IptvAdapter = { isSupported, createPlayer };
