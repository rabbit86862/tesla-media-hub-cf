// 流媒体代理：同时兼容 AppleCMS 点播、IPTV 直播与 WebDAV 私有存储
//   1) 保留 WebDAV Basic Auth 自动鉴权；
//   2) 双模式请求头自适应（优先浏览器头，遇 403/401/412 自动切换 okhttp 播放器头并剥离 Origin 重试）；
//   3) 增强 M3U8 识别（支持无 .m3u8 后缀、Content-Type 为 text/plain 的直播源内容嗅探与切片重写）。

import { fetchStream } from './fetcher.js';

const BLOCKED_KEYWORDS = ['localhost', 'internal', 'metadata', '169.254.169.254'];

function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  return BLOCKED_KEYWORDS.some((k) => h.includes(k));
}

function safeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (isBlockedHost(u.hostname)) return null;
  return u;
}

function toAbsolute(uri, baseUrl) {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith('//')) {
      const u = new URL(uri);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    }
    if (uri.startsWith('//')) {
      return new URL('https:' + uri).toString();
    }
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}

// 将 m3u8 文本中的相对/绝对 URI 改写为经过本代理的绝对地址
function rewriteM3u8(text, baseUrl, proxyBase) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      line = line.replace(/(URI=)("?)([^"\s,]+)\2/gi, (m, p1, q, uri) => {
        const abs = toAbsolute(uri, baseUrl);
        return abs ? p1 + q + proxyBase + encodeURIComponent(abs) + q : m;
      });
      out.push(line);
      continue;
    }
    if (trimmed.includes('/api/stream')) {
      out.push(line);
      continue;
    }
    const abs = toAbsolute(trimmed, baseUrl);
    if (!abs) {
      out.push(line);
      continue;
    }
    out.push(proxyBase + encodeURIComponent(abs));
  }
  return out.join('\n');
}

export async function handleStream(request, url, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  const target = url.searchParams.get('url');
  if (!target) return new Response('bad url', { status: 400 });

  const tu = safeUrl(target);
  if (!tu) return new Response('blocked or invalid url', { status: 403 });

  // 判断是否为配置的 WebDAV 域名
  let isWebdav = false;
  let webdavAuth = '';
  if (env && env.WEBDAV_BASE && env.WEBDAV_USER) {
    try {
      const wb = new URL(env.WEBDAV_BASE);
      if (tu.host === wb.host) {
        isWebdav = true;
        try {
          webdavAuth = 'Basic ' + btoa(env.WEBDAV_USER + ':' + (env.WEBDAV_PASS || ''));
        } catch (_) {
          webdavAuth = 'Basic ' + btoa(unescape(encodeURIComponent(env.WEBDAV_USER + ':' + (env.WEBDAV_PASS || ''))));
        }
      }
    } catch (_) { /* ignore */ }
  }

  const range = request.headers.get('range');

  // 构造两套请求头：一套模拟电视盒子播放器（IPTV 专用），一套模拟浏览器（点播站专用）
  const buildHeaders = (mode) => {
    const h = { Accept: '*/*' };
    if (range) h['Range'] = range;
    if (isWebdav && webdavAuth) {
      h['Authorization'] = webdavAuth;
      h['User-Agent'] = 'Mozilla/5.0';
      return h;
    }
    if (mode === 'iptv') {
      // 电视盒子播放器标识，且不带 Origin 头（防止触发直播 CDN 防盗链拒绝）
      h['User-Agent'] = 'okhttp/4.12.0';
      h['Referer'] = tu.origin + '/';
    } else {
      h['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      h['Referer'] = tu.origin + '/';
      h['Origin'] = tu.origin;
    }
    return h;
  };

  // 非 WebDAV 且路径含直播特征时，优先使用播放器头；否则先用浏览器头，被拒后自动切换重试
  const looksLikeLive = /\/(live|pltv|iptv|hls|tv)\b|\.m3u8/i.test(tu.pathname);
  const firstMode = (!isWebdav && looksLikeLive) ? 'iptv' : 'browser';
  const secondMode = firstMode === 'iptv' ? 'browser' : 'iptv';

  let up;
  try {
    up = await fetchStream(tu.toString(), { headers: buildHeaders(firstMode), redirect: 'follow' });
    // 若遇 403/401/412 防盗链拒绝，自动切换另一套请求头重试一次
    if (!isWebdav && (up.status === 403 || up.status === 401 || up.status === 412)) {
      up = await fetchStream(tu.toString(), { headers: buildHeaders(secondMode), redirect: 'follow' });
    }
  } catch (e) {
    const dbg = 'upstream error: ' + (e && e.message ? e.message : String(e)) + ' | url=' + tu.toString();
    return new Response(dbg, {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-TMH-Error': dbg,
      },
    });
  }

  if (!up.ok && up.status !== 206) {
    const dbg =
      'upstream status ' + up.status +
      ' | url=' + (up.url || tu.toString()) +
      ' | ct=' + (up.headers.get('content-type') || '');
    return new Response(dbg, {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-TMH-Error': dbg,
      },
    });
  }

  const finalBase = up.url || tu.toString();
  const ct = up.headers.get('content-type') || '';
  const cl = Number(up.headers.get('content-length') || '0');

  let isM3u8 =
    /mpegurl|application\/x-m3u8|vnd\.apple\.mpegurl/i.test(ct) ||
    /\.m3u8(\?|#|$)/i.test(new URL(finalBase).pathname);

  // 针对无 .m3u8 后缀且返回 text/plain 或未知类型的直播索引，读取文本嗅探是否以 #EXTM3U 开头
  let prefetchedText = null;
  if (!isM3u8 && !isWebdav && (cl === 0 || cl < 512 * 1024) && (/text\/plain|octet-stream|^$/i.test(ct))) {
    const clone = up.clone();
    const txt = await clone.text().catch(() => '');
    if (txt.trimStart().startsWith('#EXTM3U')) {
      isM3u8 = true;
      prefetchedText = txt;
    }
  }

  if (isM3u8) {
    const text = prefetchedText !== null ? prefetchedText : await up.text().catch(() => '');
    const proxyBase = url.origin + '/api/stream?url=';
    const rewritten = rewriteM3u8(text, finalBase, proxyBase);
    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // 其他媒体（mp4 / ts / flv / key 等）直接流式转发，透传关键响应头以支持拖拽
  const passHeaders = new Headers();
  for (const k of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
  ]) {
    const v = up.headers.get(k);
    if (v) passHeaders.set(k, v);
  }
  passHeaders.set('Access-Control-Allow-Origin', '*');
  if (!passHeaders.get('cache-control')) passHeaders.set('Cache-Control', 'public, max-age=3600');

  return new Response(up.body, {
    status: up.status,
    headers: passHeaders,
  });
}
