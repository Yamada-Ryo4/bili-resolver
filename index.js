/**
 * Bilibili Resolver & Proxy Worker
 * 
 * 双模式界面：视频 / 直播 切换
 * - 视频：原版逻辑 (1080P/720P/480P, Quest模式, 历史记录)
 * - 直播：v4.1 稳定版本 (CN/OV 节点检测)
 */

const VERSION = '20261003-010'; // 每次 push 时更新此版本号

const REFERER = 'https://www.bilibili.com/';
const LIVE_REFERER = 'https://live.bilibili.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

let WORKER_ENV = {};

// 代理 Fetch 封装，统一附加 VERCEL_PROXY 和 PROXY_TOKEN
function proxiedFetch(originalUrl, options = {}) {
    let finalUrl = originalUrl;
    const isBiliApi = typeof originalUrl === 'string' && (originalUrl.includes('api.bilibili.com') || originalUrl.includes('api.live.bilibili.com'));
    
    // Vercel 代理地址，从环境变量读取
    const proxyBase = WORKER_ENV.VERCEL_PROXY;
    if (proxyBase && isBiliApi) {
        finalUrl = proxyBase + encodeURIComponent(originalUrl);
    }
    
    const finalOptions = { ...options };
    // 给 Vercel 代理的请求统一带上 Token（从环境变量读取）
    const token = WORKER_ENV.PROXY_TOKEN;
    if (token && isBiliApi) {
        finalOptions.headers = new Headers(options.headers || {});
        finalOptions.headers.set('x-proxy-token', token);
    }
    
    return fetch(finalUrl, finalOptions);
}

// --- B 站 API 双通道 ---
// 主通道：EO 中转（bapi.yamadaryo.me，Worker 直连）。nav / pagelist / playurl / spi
// 实测均可直连；view 类与 dm（seg.so）端点在 EO 出口上可能被 412 风控。
// 备用通道：Vercel 代理（用户配置的 VERCEL_PROXY，可能已失效）→
//           bili-proxy-blue 兜底（本仓库架构的固定部署，token 与之配套）→
//           直连官方域名。
// view 解析另有 pagelist 兜底（见 resolveVideo）。
const FALLBACK_API_PROXY = 'https://bili-proxy-blue.vercel.app/api/proxy?url=';
const FALLBACK_API_PROXY_TOKEN = 'bili_token_vercel';

function biliApiOrigin() {
    const value = String(WORKER_ENV.BILIBILI_API_ORIGIN || 'https://bapi.yamadaryo.me').trim().replace(/\/+$/, '');
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && parsed.hostname ? parsed.origin : 'https://api.bilibili.com';
    } catch (e) { return 'https://api.bilibili.com'; }
}

function biliApi(path) { return biliApiOrigin() + path; }

// EO 中转地址 → 官方 api.bilibili.com 地址（非 EO 地址返回 null）。
function toOfficialApi(url) {
    try {
        const parsed = new URL(url);
        if (parsed.origin !== biliApiOrigin()) return null;
        parsed.hostname = 'api.bilibili.com';
        parsed.port = '';
        parsed.protocol = 'https:';
        return parsed.toString();
    } catch (e) { return null; }
}

// 可用的 API 代理配置列表：用户配置优先，blue 部署兜底。
function apiProxyConfigs() {
    const configs = [];
    if (WORKER_ENV.VERCEL_PROXY) configs.push({ base: WORKER_ENV.VERCEL_PROXY, token: WORKER_ENV.PROXY_TOKEN });
    configs.push({ base: FALLBACK_API_PROXY, token: FALLBACK_API_PROXY_TOKEN });
    return configs;
}

// 经由指定 Vercel 代理配置转发官方 API 请求（转发 UA / Referer / Cookie / method / body）。
function proxyApiFetch(officialUrl, options, config) {
    const headers = new Headers(options.headers || {});
    if (config.token) headers.set('x-proxy-token', config.token);
    const method = String(options.method || 'GET').toUpperCase();
    return fetch(config.base + encodeURIComponent(officialUrl), {
        method,
        headers,
        ...(method !== 'GET' && method !== 'HEAD' && options.body !== undefined ? { body: options.body } : {}),
    });
}

// 通道健康记忆：被风控/失联的「通道×端点」在 5 分钟内降到最后尝试，避免每次解析重复撞墙。
const transportHealth = new Map();
const TRANSPORT_PENALTY_MS = 5 * 60 * 1000;
function safeUrlHost(url) { try { return new URL(url).host; } catch (e) { return ''; } }
function safeUrlPath(url) { try { return new URL(url).pathname; } catch (e) { return url; } }
function transportKey(candidate, url) {
    const id = candidate.via === 'proxy'
        ? 'proxy:' + (candidate.cfg ? candidate.cfg.base : '')
        : 'direct:' + safeUrlHost(url);
    return id + safeUrlPath(url);
}
function orderCandidates(candidates) {
    const ready = [], penalized = [];
    for (const c of candidates) {
        const until = transportHealth.get(transportKey(c, c.url)) || 0;
        (Date.now() < until ? penalized : ready).push(c);
    }
    return ready.concat(penalized);
}
function markTransport(candidate, url, ok) {
    const key = transportKey(candidate, url);
    if (ok) { transportHealth.delete(key); return; }
    if (transportHealth.size > 200) transportHealth.clear();
    transportHealth.set(key, Date.now() + TRANSPORT_PENALTY_MS);
}
function resetTransportHealth() { transportHealth.clear(); }

const ERROR_MAP = {
    '-400': '请求错误', '-403': '访问权限不足', '-404': '视频不存在',
    '-10403': '仅限港澳台地区', '62002': '视频不可见', '62004': '审核中'
};

// --- 反爬错误 ---
// 统一的中文反爬提示，供视频解析链路在识别风控时返回给前端。
const ANTI_CRAWL_MSG = 'B 站风控拦截，请稍后重试';

// 哨兵错误类型：上层可通过 `instanceof AntiCrawlError` 或 `err.name === 'AntiCrawlError'`
// 识别反爬失败，而无需依赖脆弱的字符串匹配。
class AntiCrawlError extends Error {
    constructor(message = ANTI_CRAWL_MSG) {
        super(message);
        this.name = 'AntiCrawlError';
    }
}

// --- 安全 JSON 抓取助手 ---
// 集中完成「多通道重试 → 状态码检查 → Content-Type / body 嗅探 → JSON 解析 → code:-352 识别」，
// 识别到反爬时抛出带哨兵标记的 AntiCrawlError（中文消息），绝不让原始的
// `Unexpected token` / `is not valid JSON` 解析错误泄漏到上层。
// 注意：非 -352 的业务码（如 -404）不在此处理，原样返回交由调用点既有 ERROR_MAP 逻辑（保证 Preservation）。

// 单个候选响应是否为风控/拦截（应换下一通道重试而非直接失败）：
// 非 2xx、HTML 风控页、或 code -352 / -412。
function isBlockedBiliResponse(res, text) {
    if (!res.ok) return true;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json') || text.trim().startsWith('<')) return true;
    try {
        const json = JSON.parse(text);
        return json?.code === -352 || json?.code === -412;
    } catch (e) { return true; }
}

// 按通道顺序尝试同一 API 调用，返回第一个「健康」响应；
// 全部候选被风控时返回最后一个（由 fetchBiliJson 归类为 AntiCrawlError），
// 全部网络失败则直接抛 AntiCrawlError。
async function fetchBiliResponse(url, options) {
    const official = toOfficialApi(url);
    const candidates = [];
    if (official) {
        // 调用方传入 EO 中转地址：主通道直连 EO，备用各 Vercel 代理 / 直连官方域名。
        candidates.push({ url, via: 'direct' });
        for (const cfg of apiProxyConfigs()) candidates.push({ url: official, via: 'proxy', cfg });
        candidates.push({ url: official, via: 'direct' });
    } else {
        for (const cfg of apiProxyConfigs()) candidates.push({ url, via: 'proxy', cfg });
        candidates.push({ url, via: 'direct' });
    }

    let last = null;
    for (const candidate of orderCandidates(candidates)) {
        let res, text;
        try {
            res = candidate.via === 'proxy' ? await proxyApiFetch(candidate.url, options, candidate.cfg) : await fetch(candidate.url, options);
            text = await res.text();
        } catch (e) { markTransport(candidate, candidate.url, false); continue; }
        const current = { res, text };
        if (!isBlockedBiliResponse(res, text)) { markTransport(candidate, candidate.url, true); return current; }
        markTransport(candidate, candidate.url, false);
        last = current;
    }
    if (last) return last;
    throw new AntiCrawlError();
}

async function fetchBiliJson(url, options) {
    const { res, text } = await fetchBiliResponse(url, options);

    // 1) 非 2xx 视为反爬 / 异常。优先检查是否是 Vercel 代理本身的报错
    if (!res.ok) {
        if (res.status === 401 || text.includes('Unauthorized')) throw new Error('Vercel 代理鉴权失败：请检查 Cloudflare 上的 PROXY_TOKEN 是否与 Vercel 中的代码一致');
        if (res.status === 404 || text.includes('NOT_FOUND')) throw new Error('Vercel 代理地址失效：请检查 VERCEL_PROXY 变量结尾是否带了 /api/proxy?url=');
        throw new AntiCrawlError();
    }

    // 2) Content-Type 非 JSON，或 body 以 '<' 开头（HTML / DOCTYPE 风控页）→ 反爬。
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json') || text.trim().startsWith('<')) {
        throw new AntiCrawlError();
    }

    // 3) JSON 解析失败（避免原始 SyntaxError 泄漏）→ 反爬。
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new AntiCrawlError();
    }

    // 4) 风控校验失败码 → 反爬。
    if (json.code === -352) throw new AntiCrawlError();

    // 5) 其余（含其它业务码）原样返回。
    return json;
}

// --- Buvid ---
async function getBuvid() {
    try {
        const json = await fetchBiliJson(biliApi('/x/frontend/finger/spi'), { headers: { "User-Agent": UA } });
        return json.data?.b_3 || "FE6D3664-927F-F75B-B7D4-733E5D4B263F69428infoc";
    } catch (e) { return "FE6D3664-927F-F75B-B7D4-733E5D4B263F69428infoc"; }
}

// --- 反爬 Cookie 采集 ---
// 同 getBuvid() 的硬编码回退 buvid3，确保 finger/spi 失败时 Cookie 至少含 buvid3。
const FALLBACK_BUVID3 = "FE6D3664-927F-F75B-B7D4-733E5D4B263F69428infoc";

// 自包含的 HMAC-SHA256 hex 计算（走原生 WebCrypto crypto.subtle），用于生成
// bili_ticket 所需的 hexsign。key = 'XgwSnGZ1p'，message = 'ts' + ts。
async function hmacSha256Hex(key, message) {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 采集降低风控概率的反爬 Cookie：
//   1) finger/spi -> buvid3 (b_3) / buvid4 (b_4)；失败则回退到硬编码 buvid3 常量。
//   2) 可选叠加 bili_ticket（HMAC-SHA256 + GenWebTicket），整段 try/catch 降级，
//      任何失败都不阻断主流程，退化为仅 buvid3/buvid4。
//   3) 拼接 Cookie 字符串（缺失项跳过）；buvid3 始终存在。
// getBuvid() 的签名与回退常量保持不变（直播链路继续使用）。
async function getAntiCrawlCookie() {
    let buvid3 = FALLBACK_BUVID3;
    let buvid4 = null;

    // 1) finger/spi -> b_3 / b_4
    try {
        const json = await fetchBiliJson(biliApi('/x/frontend/finger/spi'), { headers: { "User-Agent": UA } });
        if (json.data?.b_3) buvid3 = json.data.b_3;
        if (json.data?.b_4) buvid4 = json.data.b_4;
    } catch (e) { /* 保留 fallback buvid3 */ }

    // 2) 可选 bili_ticket（任何失败都优雅降级）
    let ticket = null;
    try {
        const ts = Math.floor(Date.now() / 1000);
        const hexsign = await hmacSha256Hex('XgwSnGZ1p', 'ts' + ts);
        const ticketUrl = biliApi(`/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign=${hexsign}&context[ts]=${ts}&csrf=`);
        const json = await fetchBiliJson(ticketUrl, { method: 'POST', headers: { "User-Agent": UA } });
        if (json.data?.ticket) ticket = json.data.ticket;
    } catch (e) { /* 降级为仅 buvid3 / buvid4 */ }

    // 3) 拼接 Cookie（缺失项跳过；buvid3 始终存在）
    const parts = [`buvid3=${buvid3}`];
    if (buvid4) parts.push(`buvid4=${buvid4}`);
    if (ticket) parts.push(`bili_ticket=${ticket}`);
    return parts.join('; ');
}

// --- WBI 签名 ---
const mixinKeyEncTab = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const getMixinKey = (orig) => mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
async function md5(text) {
    const hashBuffer = await crypto.subtle.digest('MD5', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// 从 nav 接口取 wbi_img 并派生 mixin_key。
// 走 fetchBiliJson（注入 User-Agent / Referer / Cookie），识别到反爬时抛 AntiCrawlError，
// 而非对 HTML 风控页调 .json() 抛出原始 `Unexpected token`。
// 对合法 nav 数据，mixin_key 的派生（getMixinKey over img_url/sub_url basenames）与改造前完全一致。
// 拆出此函数是为了让单次解析内只取一次 nav：getPlayUrlWithFallback 的 fallback 循环
// 可复用缓存的 mixin_key，而不必每个清晰度都重新请求 nav。
async function getMixinKeyFromNav(cookie) {
    const json = await fetchBiliJson(biliApi('/x/web-interface/nav'), {
        headers: { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie }
    });
    const { img_url, sub_url } = json.data.wbi_img;
    return getMixinKey(img_url.split('/').pop().split('.')[0] + sub_url.split('/').pop().split('.')[0]);
}

// WBI 签名。
// - 若传入预先计算好的 `mixinKey`，直接使用（不再请求 nav）；
// - 否则通过 getMixinKeyFromNav(cookie) 取一次（cookie 可为 undefined，向后兼容 signWbi(params)）。
// 对合法 nav 数据，签名输出（query + w_rid）与改造前逐字节一致：mixin_key 派生、wts、
// 参数排序、md5(query + mixin_key) 的逻辑均未改变，只有「取 nav 的方式」与「nav 缓存拆分」发生变化。
async function signWbi(params, cookie, mixinKey) {
    const mixin_key = mixinKey !== undefined ? mixinKey : await getMixinKeyFromNav(cookie);
    const curr_params = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(curr_params).sort().map(k => `${k}=${encodeURIComponent(curr_params[k])}`).join('&');
    return query + `&w_rid=${await md5(query + mixin_key)}`;
}

// --- APP / TV 端取流签名 ---
// 数据中心 IP 上 web 端 playurl 极易被风控（-352）。APP / TV 端使用 appkey + sign
// 签名的接口走另一套风控策略，对未登录游客的容忍度通常更高，故作为 web 线路的备用。
// appkey / appsec 来自公开的逆向资料（bilibili-API-collect: docs/misc/sign/APPKey.md）。
const APP_KEYS = {
    // iOS 视频取流专用
    ios: { appkey: 'YvirImLGlLANCLvM', appsec: 'JNlZNgfNGKZEpaDTkCdPQVXntXhuiJEM', platform: 'ios', ua: 'Bilibili/8.0.0 (bbcallen@gmail.com)' },
    // 云视听小电视 TV 版
    tv: { appkey: '4409e2ce8ffd12b8', appsec: '59b43e04ad6965f34319062b478f83dd', platform: 'android', ua: 'Bilibili Freedoooooom/MOD' }
};

// APP API 签名：加 appkey → 按 key 排序 → urlencode 序列化 → 拼 appsec → md5(32 位小写) → sign。
// 算法见 bilibili-API-collect: docs/misc/sign/APP.md。
async function appSign(params, appkey, appsec) {
    const all = { ...params, appkey };
    const query = Object.keys(all).sort().map(k => `${k}=${encodeURIComponent(all[k])}`).join('&');
    return query + `&sign=${await md5(query + appsec)}`;
}

// --- 视频解析 (多线路取流) ---
// 数据中心 IP 上 web 端 playurl 极易被风控（-352 / HTML 风控页）。为在纯 serverless
// 前提下尽量提高成功率，对每个清晰度依次尝试多条独立线路（APP iOS 取流 → TV → web），
// 任一线路成功即返回；只有当所有线路在所有清晰度上都失败时才报错。
//
// - APP / TV 线路用 appkey+sign 签名，走另一套风控策略，对未登录游客容忍度通常更高；
//   web 线路保留 wbi 签名并加 try_look=1 + platform=html5（未登录可拉 720P/1080P、无 referer 鉴权）。
// - nav（mixin_key）仅 web 线路需要，且整个过程只取一次：调用方未传入则在进入循环前计算一次。
//   若 nav 本身就是反爬响应，web 线路会被跳过，但 APP/TV 线路不依赖 nav，仍可继续尝试。
// - 反爬识别（fetchBiliJson 抛 AntiCrawlError）被视为「该线路失败」记入 lastError 并尝试下一条，
//   而非立即整体放弃——因为别的线路可能没被风控。全部线路皆失败时，若失败原因全是反爬则抛
//   AntiCrawlError（前端显示中文风控提示），否则抛普通业务错误。
// - Preservation：成功返回 { url, quality } 的结构不变；web 线路的业务失败回退语义保持。
async function getPlayUrlWithFallback(bvid, cid, targetQn, cookie, mixinKey) {
    const qualities = [targetQn, 80, 64, 32].filter((v, i, a) => a.indexOf(v) === i && v <= targetQn);

    // 仅 web 线路需要 mixin_key；取 nav 失败（含反爬）不应阻断 APP/TV 线路。
    let mixin_key = mixinKey;
    let navAvailable = true;
    if (mixin_key === undefined) {
        try {
            mixin_key = await getMixinKeyFromNav(cookie);
        } catch (e) {
            navAvailable = false; // nav 取不到（可能被风控），web 线路跳过，仍尝试 APP/TV
        }
    }

    let lastError = null;
    let sawAntiCrawl = false;

    // 单条线路：成功返回 { url, quality }；失败抛错（由调用处归类）。
    const tryAppLine = async (qn, conf) => {
        const params = { bvid, cid: String(cid), qn: String(qn), fnval: '1', fnver: '0', fourk: '1', platform: conf.platform, ts: String(Math.floor(Date.now() / 1000)) };
        const signed = await appSign(params, conf.appkey, conf.appsec);
        const pData = await fetchBiliJson(biliApi(`/x/player/playurl?${signed}`), {
            headers: { 'User-Agent': conf.ua }
        });
        if (pData.code === 0 && pData.data?.durl?.[0]?.url) {
            return { url: pData.data.durl[0].url, quality: pData.data.quality };
        }
        throw new Error(pData.message || ERROR_MAP[pData.code] || '取流失败');
    };

    const tryWebLine = async (qn) => {
        const signedQuery = await signWbi({ bvid, cid, qn, fnval: 1, try_look: 1, platform: 'html5', high_quality: 1 }, cookie, mixin_key);
        const pData = await fetchBiliJson(biliApi(`/x/player/wbi/playurl?${signedQuery}`), {
            headers: { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie }
        });
        if (pData.code === 0 && pData.data?.durl?.[0]?.url) {
            return { url: pData.data.durl[0].url, quality: pData.data.quality };
        }
        throw new Error(pData.message || ERROR_MAP[pData.code] || '取流失败');
    };

    for (const qn of qualities) {
        const lines = [
            () => tryAppLine(qn, APP_KEYS.ios),
            () => tryAppLine(qn, APP_KEYS.tv),
        ];
        if (navAvailable) lines.push(() => tryWebLine(qn));

        for (const line of lines) {
            try {
                return await line();
            } catch (e) {
                if (e instanceof AntiCrawlError || e.name === 'AntiCrawlError') {
                    sawAntiCrawl = true;
                } else {
                    lastError = e.message;
                }
                // 该线路失败，尝试下一条线路 / 下一档清晰度。
            }
        }
    }

    // 全部线路皆失败：若出现过反爬且无其它业务错误，报中文风控；否则报业务错误。
    if (sawAntiCrawl && !lastError) throw new AntiCrawlError();
    throw new Error(lastError || (sawAntiCrawl ? ANTI_CRAWL_MSG : "视频解析失败"));
}

// 单次解析内只采集一次反爬 Cookie（finger/spi 仅请求一次），并将 Cookie 注入
// view / nav / playurl 三个请求。view 走 fetchBiliJson（识别反爬抛 AntiCrawlError，
// 不再对 HTML 风控页调 .json() 泄漏 `Unexpected token`）。
// view 主通道被 412 风控时，用 pagelist（轻端点，EO 上实测可用）兜底拿 cid 与分 P 标题，
// 封面 / 作者降级为空；pagelist 也失败时抛出 view 的原始错误。
// 顺序保留：先 view（含兜底），通过后再取一次 nav（mixin_key），最后 playurl。
async function resolveVideo(bvid, qn, host) {
    const cookie = await getAntiCrawlCookie();

    let vData = null;
    let viewError = null;
    try {
        vData = await fetchBiliJson(biliApi(`/x/web-interface/view?bvid=${bvid}`), {
            headers: { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie }
        });
    } catch (e) {
        viewError = e;
    }

    if (!vData || vData.code !== 0) {
        try {
            const pl = await fetchBiliJson(biliApi(`/x/player/pagelist?bvid=${bvid}`), {
                headers: { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie }
            });
            const first = pl && pl.code === 0 && Array.isArray(pl.data) ? pl.data[0] : null;
            const cid = Number(first && first.cid);
            if (first && Number.isFinite(cid) && cid > 0) {
                vData = { code: 0, data: { cid, title: String(first.part || ''), pic: '', owner: null } };
                viewError = null;
            }
        } catch (e) { /* 保留 view 原始错误 */ }
    }

    if (!vData || vData.code !== 0) {
        if (viewError) throw viewError;
        throw new Error(ERROR_MAP[vData && vData.code] || (vData && vData.message) || '视频解析失败');
    }

    if (vData.data.rights && vData.data.rights.pay === 1) throw new Error('该视频为B站付费内容，游客无法解析');
    const { cid, title, pic, owner } = vData.data;
    // 不在此预取 nav：nav 在数据中心 IP 上可能被风控，预取失败会阻断 APP/TV 取流线路。
    // 将 nav（mixin_key）的获取交给 getPlayUrlWithFallback 内部按需、容错地处理。
    const videoStream = await getPlayUrlWithFallback(bvid, cid, qn || 116, cookie);

    // playableUrl 走 /proxy 中转：代理会附加正确的 Referer，使浏览器 Range 请求（进度条拖动）正常工作
    // 已修复：代理底层通过抛弃僵尸连接（传递 AbortSignal），彻底解决拖动卡死问题
    const playableUrl = `${host}/proxy?url=${encodeURIComponent(videoStream.url)}&name=${encodeURIComponent(title)}`;
    const downloadUrl = `${host}/proxy?url=${encodeURIComponent(videoStream.url)}&name=${encodeURIComponent(title)}&dl=1`;

    return { title, pic, bvid, author: owner ? owner.name : '', playableUrl, downloadUrl, quality: videoStream.quality, isLive: false };
}

// --- 直播解析 (v4.1) ---
async function resolveLive(roomId, host) {
    const infoRes = await proxiedFetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
        headers: { 'User-Agent': UA, 'Referer': LIVE_REFERER }
    });
    const infoData = await infoRes.json();
    if (infoData.code !== 0) throw new Error("直播间不存在");

    const { title, user_cover, keyframe, live_status, room_id: realRoomId, uid } = infoData.data;
    if (live_status !== 1 && live_status !== 2) throw new Error("主播未开播");

    const buvid = await getBuvid();
    const getHeaders = () => ({
        'User-Agent': UA_MOBILE,
        'Referer': `https://live.bilibili.com/${realRoomId}`,
        'Origin': 'https://live.bilibili.com',
        'Cookie': `buvid3=${buvid}`
    });

    // Legacy API (稳定)
    const fetchStreamLegacy = async () => {
        const api = `https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${realRoomId}&platform=h5&quality=3`;
        try {
            const res = await proxiedFetch(api, { headers: getHeaders() });
            const data = await res.json();
            if (data.data?.durl?.[0]?.url) {
                const url = data.data.durl[0].url;
                const isCN = url.includes('cn-');
                return { url, nodeType: isCN ? 'CN' : 'OV' };
            }
        } catch (e) { }
        return null;
    };

    // V2 API 备用
    const fetchStreamV2 = async () => {
        const api = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${realRoomId}&protocol=0,1&format=0,1,2&codec=0,1&platform=h5&qn=150`;
        try {
            const res = await proxiedFetch(api, { headers: getHeaders() });
            const data = await res.json();
            const streams = data.data?.playurl_info?.playurl?.stream;
            if (!streams) return null;
            for (const s of streams) {
                if (s.format?.[0]?.codec?.[0]) {
                    const codecInfo = s.format[0].codec[0];
                    const urlInfos = codecInfo.url_info;
                    const cnNode = urlInfos.find(u => u.host.includes('cn-'));
                    if (cnNode) {
                        return { url: cnNode.host + codecInfo.base_url + cnNode.extra, nodeType: 'CN' };
                    }
                    return { url: urlInfos[0].host + codecInfo.base_url + urlInfos[0].extra, nodeType: 'OV' };
                }
            }
        } catch (e) { }
        return null;
    };

    let result = await fetchStreamLegacy();
    if (!result) result = await fetchStreamV2();
    if (!result) throw new Error("获取直播流失败");

    // 直播流使用 Vercel + CF 混合代理：
    // m3u8 播放列表通过 Vercel 代理获取（绕过 CF IP 被 ov 节点拦截），ts 切片直连 CDN
    // 配合 <meta name="referrer" content="no-referrer"> 测试空 Referer
    const playableUrl = `${host}/proxy?url=${encodeURIComponent(result.url)}&live=1&m3u8_direct=1`;
    const isHLS = result.url.includes('.m3u8');
    const formatStr = `${isHLS ? 'HLS' : 'FLV'} (${result.nodeType})`;

    return {
        title,
        pic: user_cover || keyframe,
        author: `UID:${uid}`,
        playableUrl,
        downloadUrl: result.url,
        quality: 0,
        isLive: true,
        format: formatStr,
        nodeType: result.nodeType
    };
}

// --- 双模式 UI ---
const UI = (host) => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="referrer" content="no-referrer">
    <title>Bilibili 解析</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
        body { background: #0f172a; font-family: 'Noto Sans SC', sans-serif; }
        .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.1); }
        .bg-gradient-mesh { background: radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%), radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%); position: fixed; inset: 0; z-index: -1; }
        #bg-cover { position: fixed; inset: 0; z-index: -1; opacity: 0; transition: 1s; background-size: cover; background-position: center; filter: blur(30px) brightness(0.4); transform: scale(1.1); }
        .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(100px); background: rgba(0,0,0,0.8); color: white; padding: 10px 20px; border-radius: 50px; transition: 0.3s; z-index: 100; }
        .toast.show { transform: translateX(-50%) translateY(0); }
        .toast.warn { background: rgba(180,80,0,0.9); }
        .mode-btn { transition: all 0.2s; }
        .mode-btn.active { background: linear-gradient(to right, #2563eb, #4f46e5); color: white; }
    </style>
</head>
<body class="text-slate-100 min-h-screen flex flex-col items-center justify-center p-4">
    <div class="bg-gradient-mesh"></div>
    <div id="bg-cover"></div>

    <div class="w-full max-w-lg relative z-10">
        <div class="text-center mb-6 space-y-1">
            <h1 class="text-4xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-pink-500">BILI PARSER</h1>
            <p class="text-xs font-bold text-slate-500 tracking-[0.4em] uppercase">v3.2</p>
        </div>

        <!-- 模式切换 -->
        <div class="flex justify-center mb-4">
            <div class="glass rounded-full p-1 flex gap-1">
                <button id="modeVideo" onclick="setMode('video')" class="mode-btn active px-4 py-2 rounded-full text-sm font-bold">📺 视频</button>
                <button id="modeLive" onclick="setMode('live')" class="mode-btn px-4 py-2 rounded-full text-sm font-bold text-slate-400 hover:text-white">📡 直播</button>
            </div>
        </div>

        <div class="glass rounded-3xl p-6 space-y-4">
            <!-- 视频模式 -->
            <div id="videoPanel" class="space-y-3">
                <input type="text" id="videoInput" placeholder="粘贴 BV号 / 视频链接..." 
                    class="w-full bg-slate-900/60 border border-slate-700/50 rounded-xl px-4 py-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none text-center">
                
                <div class="flex gap-2">
                    <select id="videoQn" class="bg-slate-900/60 border border-slate-700/50 rounded-xl px-3 py-3 text-xs text-slate-300 w-1/3 text-center">
                        <option value="116">1080P+</option>
                        <option value="80" selected>1080P</option>
                        <option value="64">720P</option>
                        <option value="32">480P</option>
                    </select>
                    <button onclick="parseVideo()" class="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 font-bold py-3 rounded-xl shadow-lg active:scale-95">解析视频</button>
                </div>

                <div class="flex justify-between items-center px-1 pt-1">
                    <span class="text-[10px] text-slate-500 font-bold tracking-widest">OPTIONS</span>
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" id="questMode" class="peer hidden">
                        <div class="w-3.5 h-3.5 rounded border border-slate-500 peer-checked:bg-blue-500 peer-checked:border-blue-500 flex items-center justify-center">
                            <svg class="w-2.5 h-2.5 text-white hidden peer-checked:block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7"></path></svg>
                        </div>
                        <span class="text-xs text-slate-400 peer-checked:text-blue-400">Quest 兼容</span>
                    </label>
                </div>
            </div>

            <!-- 直播模式 -->
            <div id="livePanel" class="hidden space-y-3">
                <input type="text" id="liveInput" placeholder="输入直播房间号..." 
                    class="w-full bg-slate-900/60 border border-slate-700/50 rounded-xl px-4 py-4 text-sm focus:ring-2 focus:ring-pink-500 outline-none text-center">
                
                <button onclick="parseLive()" class="w-full bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 font-bold py-3 rounded-xl shadow-lg active:scale-95">解析直播</button>
                
                <p class="text-[10px] text-slate-500 text-center">⚠️ OV 节点可能无法播放，需多尝试几次</p>
            </div>

            <!-- 加载 -->
            <div id="loader" class="hidden py-8 text-center"><div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div></div>

            <!-- 结果 -->
            <div id="result" class="hidden space-y-4 pt-4 border-t border-white/5">
                <div id="playerBox" class="relative"><video id="inlineVideo" class="hidden w-full rounded-xl bg-black" controls playsinline></video><div id="danmakuLayer" class="absolute inset-0 pointer-events-none overflow-hidden" style="font-weight:700;color:#fff;text-shadow:0 1px 3px #000,0 0 2px #000"></div></div>
                <div class="flex gap-4 items-start">
                    <img id="resPic" referrerpolicy="no-referrer" class="w-28 h-16 object-cover rounded-lg shadow-md bg-slate-800 shrink-0">
                    <div class="min-w-0 flex-1 space-y-1">
                        <h3 id="resTitle" class="text-sm font-bold leading-tight line-clamp-2"></h3>
                        <p id="resAuthor" class="text-[10px] text-slate-400 truncate"></p>
                        <div class="flex items-center gap-2">
                            <span id="resTag" class="text-[10px] bg-pink-500/20 text-pink-300 px-1.5 py-0.5 rounded font-bold uppercase">VIDEO</span>
                            <span id="resQuality" class="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">1080P</span>
                        </div>
                    </div>
                </div>
                <div class="relative">
                    <input id="link" readonly class="w-full bg-slate-900/40 border border-slate-700/50 rounded-xl px-4 py-3 text-xs text-slate-300 outline-none font-mono tracking-tight">
                    <button onclick="copyLink()" class="absolute right-2 top-2 bg-slate-700/50 hover:bg-slate-600 text-xs px-3 py-1 rounded-lg transition">复制</button>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <a id="btnPreview" target="_blank" class="flex items-center justify-center bg-slate-700/50 hover:bg-slate-700 py-3 rounded-xl text-sm font-bold transition">预览</a>
                    <a id="btnDownload" href="#" class="flex items-center justify-center bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 py-3 rounded-xl text-sm font-bold shadow-lg transition transform hover:-translate-y-0.5 text-center">下载</a>
                </div>
            </div>
        </div>

        <!-- 历史记录 (仅视频) -->
        <div id="historyArea" class="hidden mt-6 glass rounded-3xl p-5">
            <h4 class="text-xs font-bold text-slate-500 uppercase mb-3 flex justify-between"><span>最近解析</span><span onclick="clearHistory()" class="cursor-pointer hover:text-white">清除</span></h4>
            <div id="historyList" class="space-y-2"></div>
        </div>

        <p class="text-center text-[10px] text-slate-600 mt-4"></p>
    </div>

    <div id="toast" class="toast">消息</div>

    <script>
        let currentMode = 'video';
        let currentPlayableUrl = '';
        let isCurrentLive = false;
        const PREFETCH_WINDOW_SIZE = 10;
        let hlsPreview = null;
        let seekAbortController = null;
        let levelFragments = new Map();
        let seekGeneration = 0;

        function setMode(mode) {
            currentMode = mode;
            document.querySelectorAll('.mode-btn').forEach(b => {
                b.classList.remove('active', 'text-white');
                b.classList.add('text-slate-400');
            });
            document.getElementById(mode === 'video' ? 'modeVideo' : 'modeLive').classList.add('active', 'text-white');
            document.getElementById(mode === 'video' ? 'modeVideo' : 'modeLive').classList.remove('text-slate-400');
            
            document.getElementById('videoPanel').style.display = mode === 'video' ? 'block' : 'none';
            document.getElementById('livePanel').style.display = mode === 'live' ? 'block' : 'none';
            document.getElementById('result').classList.add('hidden');
            document.getElementById('historyArea').classList.toggle('hidden', mode !== 'video' || !hasHistory());
        }

        function hasHistory() { return JSON.parse(localStorage.getItem('bili_history') || '[]').length > 0; }

        function showToast(msg, type='success') {
            const t = document.getElementById('toast');
            t.innerText = msg;
            t.className = 'toast show ' + (type === 'warn' ? 'warn' : '');
            setTimeout(() => t.classList.remove('show'), 2500);
        }


        function loadHistory() {
            const h = JSON.parse(localStorage.getItem('bili_history') || '[]');
            const list = document.getElementById('historyList'); const area = document.getElementById('historyArea');
            list.innerHTML = ''; if (h.length === 0 || currentMode !== 'video') { area.classList.add('hidden'); return; }
            area.classList.remove('hidden');
            h.forEach(item => {
                const div = document.createElement('div');
                div.className = 'flex items-center gap-3 p-2 hover:bg-white/5 rounded-lg cursor-pointer';
                div.onclick = () => { document.getElementById('videoInput').value = item.bvid; parseVideo(); };
                div.innerHTML = \`<div class="w-10 h-6 bg-slate-800 rounded bg-cover bg-center" style="background-image:url('\${item.pic}')"></div><p class="text-xs truncate text-slate-300 flex-1">\${item.title}</p>\`;
                list.appendChild(div);
            });
        }
        function saveHistory(data) {
            let h = JSON.parse(localStorage.getItem('bili_history') || '[]'); 
            h = h.filter(x => x.bvid !== data.bvid);
            h.unshift({ bvid: data.bvid, title: data.title, pic: data.pic });
            if (h.length > 5) h.pop(); 
            localStorage.setItem('bili_history', JSON.stringify(h)); 
            loadHistory();
        }
        function clearHistory() { localStorage.removeItem('bili_history'); loadHistory(); }
        loadHistory();
        const initialText = new URLSearchParams(location.search).get('text');
        if (initialText) { document.getElementById('videoInput').value = initialText; parseVideo(); }

        // --- 弹幕层（resources=bilibarrage2） ---
        const dmState = { items: [], lastT: -1, lane: 0 };
        function dmClear() {
            const layer = document.getElementById('danmakuLayer');
            if (layer) layer.innerHTML = '';
            dmState.items = []; dmState.lastT = -1; dmState.lane = 0;
        }
        async function dmLoad(bvid) {
            dmClear();
            try {
                const res = await fetch('/player/?resources=bilibarrage2&id=' + encodeURIComponent(bvid));
                const j = await res.json();
                const d = j.data || {};
                const items = [];
                (d.RollBarrage || []).forEach(x => items.push({ text: x.text, t: x.time, type: 'roll', done: false }));
                (d.BottomBarrage || []).forEach(x => items.push({ text: x.text, t: x.time, type: 'bottom', done: false }));
                (d.TopBarrage || []).forEach(x => items.push({ text: x.text, t: x.time, type: 'top', done: false }));
                items.sort((a, b) => a.t - b.t);
                dmState.items = items;
            } catch (e) {}
        }
        function dmSpawn(item) {
            const layer = document.getElementById('danmakuLayer');
            if (!layer || !item.text) return;
            const el = document.createElement('div');
            el.textContent = item.text;
            el.style.position = 'absolute';
            el.style.whiteSpace = 'nowrap';
            if (item.type === 'roll') {
                const lanes = Math.max(1, Math.floor(layer.clientHeight / 26));
                el.style.top = ((dmState.lane % lanes) * 26 + 4) + 'px';
                dmState.lane += 1;
                el.style.left = '100%';
                el.style.transition = 'transform 9s linear';
                layer.appendChild(el);
                requestAnimationFrame(() => { el.style.transform = 'translateX(-' + (layer.clientWidth + el.offsetWidth + 20) + 'px)'; });
                setTimeout(() => el.remove(), 9200);
            } else {
                el.style.left = '50%';
                el.style.transform = 'translateX(-50%)';
                if (item.type === 'top') el.style.top = '6px'; else el.style.bottom = '8px';
                layer.appendChild(el);
                setTimeout(() => el.remove(), 4000);
            }
        }
        function dmTick(video) {
            if (!dmState.items.length || video.paused) return;
            const t = video.currentTime;
            if (t < dmState.lastT - 1.5) dmState.items.forEach(i => { i.done = false; });
            dmState.lastT = t;
            for (const item of dmState.items) {
                if (item.done || item.t > t) continue;
                item.done = true;
                if (t - item.t < 5) dmSpawn(item);
            }
        }
        document.getElementById('inlineVideo').addEventListener('timeupdate', function() { dmTick(this); });

        function copyLink() {
            const link = document.getElementById('link').value;
            if(link) { navigator.clipboard.writeText(link); showToast('已复制'); }
        }

        async function parseVideo() {
            const input = document.getElementById('videoInput').value;
            const isQuest = document.getElementById('questMode').checked;
            const qn = isQuest ? 64 : document.getElementById('videoQn').value;
            if (!input) { showToast('请输入内容'); return; }
            
            document.getElementById('loader').classList.remove('hidden'); 
            document.getElementById('result').classList.add('hidden');
            document.getElementById('bg-cover').style.opacity = '0';

            try {
                const res = await fetch('/api/video?text=' + encodeURIComponent(input) + '&qn=' + qn);
                const data = await res.json();
                if (data.status === 'success') {
                    showResult(data, isQuest);
                    saveHistory(data);
                } else showToast(data.message);
            } catch (e) { showToast('请求失败'); } 
            finally { document.getElementById('loader').classList.add('hidden'); }
        }

        async function parseLive() {
            const input = document.getElementById('liveInput').value;
            if (!input) { showToast('请输入房间号'); return; }
            
            document.getElementById('loader').classList.remove('hidden'); 
            document.getElementById('result').classList.add('hidden');
            document.getElementById('bg-cover').style.opacity = '0';

            try {
                const res = await fetch('/api/live?room=' + encodeURIComponent(input));
                const data = await res.json();
                if (data.status === 'success') {
                    showResult(data, false);
                } else showToast(data.message);
            } catch (e) { showToast('请求失败'); } 
            finally { document.getElementById('loader').classList.add('hidden'); }
        }

        function getPreviewUrl(data) { return data.playableUrl; }
        function startInlinePreview(url) {
            const video = document.getElementById('inlineVideo');
            video.classList.remove('hidden');
            if (hlsPreview) { hlsPreview.destroy(); hlsPreview = null; }
            if (!window.Hls || !Hls.isSupported()) { video.src = url; return; }
            hlsPreview = new Hls({ enableWorker: true, startLevel: 0, autoStartLoad: true, maxBufferLength: 45, maxMaxBufferLength: 90, backBufferLength: 60, fragLoadingMaxRetry: 4, fragLoadingRetryDelay: 500 });
            hlsPreview.loadSource(url);
            hlsPreview.attachMedia(video);
            hlsPreview.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
                const fragments = (data.details?.fragments || []).map(f => ({ start: f.start, duration: f.duration, url: f.url }));
                if (fragments.length) levelFragments.set(data.level, fragments);
            });
            const prefetch = (time) => {
                if (seekAbortController) seekAbortController.abort();
                seekAbortController = new AbortController();
                const fragments = Array.from(levelFragments.values())[0] || [];
                let index = fragments.findIndex(f => f.start <= time && time < f.start + f.duration);
                if (index < 0) index = fragments.findIndex(f => f.start >= time);
                if (index < 0) index = fragments.length - 1;
                const selected = fragments.slice(index, index + PREFETCH_WINDOW_SIZE);
                Promise.allSettled(selected.map(f => fetch(f.url, { cache: 'force-cache', signal: seekAbortController.signal }))).catch(() => {});
            };
            video.addEventListener('seeking', () => { hlsPreview.stopLoad(); hlsPreview.startLoad(video.currentTime); prefetch(video.currentTime); });
            hlsPreview.on(Hls.Events.ERROR, (_event, detail) => { if (detail.fatal && detail.type === Hls.ErrorTypes.NETWORK_ERROR) { hlsPreview.stopLoad(); hlsPreview.startLoad(video.currentTime); } });
        }

        function showResult(data, isQuest) {
            const pic = data.pic.replace('http:', 'https:');
            currentPlayableUrl = data.playableUrl;
            isCurrentLive = data.isLive;
            document.getElementById('resPic').src = pic;
            document.getElementById('bg-cover').style.backgroundImage = "url('" + pic + "')";
            document.getElementById('bg-cover').style.opacity = '0.4';
            document.getElementById('resTitle').innerText = data.title;
            document.getElementById('resAuthor').innerText = data.author;
            
            const tag = document.getElementById('resTag');
            const qn = document.getElementById('resQuality');
            const btnDl = document.getElementById('btnDownload');
            
            const btnPreview = document.getElementById('btnPreview');
            document.getElementById('link').value = data.playableUrl;
            btnPreview.href = data.playableUrl;
            if (!data.isLive) {
                btnPreview.onclick = (event) => { event.preventDefault(); startInlinePreview(getPreviewUrl(data)); };
            }
            if (data.isLive) {
                tag.innerText = 'LIVE';
                tag.className = 'text-[10px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded font-bold uppercase';
                qn.innerText = data.format;
                btnDl.innerText = '复制直链';
                btnDl.href = '#';
                btnDl.onclick = (e) => { e.preventDefault(); navigator.clipboard.writeText(data.downloadUrl); showToast('直链已复制'); };
            } else {
                tag.innerText = 'VIDEO';
                tag.className = 'text-[10px] bg-pink-500/20 text-pink-300 px-1.5 py-0.5 rounded font-bold uppercase';
                const qnMap = { 116: '1080P+', 80: '1080P', 64: '720P', 32: '480P' };
                qn.innerText = isQuest ? 'Quest' : (qnMap[data.quality] || 'MP4');
                btnDl.innerText = '下载';
                btnDl.href = data.downloadUrl;
                btnDl.onclick = null;
            }
            
            document.getElementById('result').classList.remove('hidden');
            if (!data.isLive) {
                const bvMatch = (document.getElementById('videoInput').value.match(/BV[a-zA-Z0-9]{10}/i) || [])[0];
                if (bvMatch) dmLoad(bvMatch); else dmClear();
            } else dmClear();
        }
    </script>
</body>
</html>
`;

// --- Proxy ---
async function handleProxy(request, url, host) {
    const target = url.searchParams.get('url');
    const name = url.searchParams.get('name');
    const isDownload = url.searchParams.get('dl') === '1';
    if (!target) return new Response('Missing URL', { status: 400 });
    const isLive = url.searchParams.get('live') === '1' || target.includes('live-bvc');
    const m3u8Direct = url.searchParams.get('m3u8_direct') === '1';
    try {
        const targetUrl = new URL(target);
        if (!targetUrl.hostname.includes('bilivideo') && !targetUrl.hostname.includes('hdslb') && !targetUrl.hostname.includes('akamaized')) {
            return new Response('Forbidden', { status: 403 });
        }
    } catch (e) { return new Response('Invalid URL', { status: 400 }); }

    const isM3u8 = target.includes('.m3u8');

    const newHeaders = new Headers({
        'Referer': isLive ? LIVE_REFERER : REFERER,
        'User-Agent': isLive ? UA_MOBILE : UA,
        'Origin': isLive ? 'https://live.bilibili.com' : 'https://www.bilibili.com'
    });
    
    // 只转发 Range 请求头。绝对不能转发 If-Range 或 If-Match，因为 CF 会修改 ETag，导致 B 站 CDN 校验失败从而忽略 Range 返回 200 全量视频
    const forwardHeaders = ['Range'];
    for (const h of forwardHeaders) {
        if (request.headers.has(h)) newHeaders.set(h, request.headers.get(h));
    }

    try {
        // Accept-Encoding: identity 避免 CF 压缩导致串流卡顿
        newHeaders.set('Accept-Encoding', 'identity');
        let response;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (attempt > 1) {
                newHeaders.set('Cache-Control', 'no-cache');
                newHeaders.set('X-Proxy-Retry', String(attempt));
            }
            response = await fetch(target, { headers: newHeaders, cf: { cacheEverything: false } });
            if (response.status < 500 && response.status !== 403 && response.status !== 429) break;
            try { await response.body?.cancel(); } catch (e) {}
            await new Promise(resolve => setTimeout(resolve, attempt * 150));
        }

        const responseHeaders = new Headers();
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Range, Accept-Ranges, Cache-Control');
        responseHeaders.set('Cache-Control', response.ok ? 'public, max-age=86400, immutable' : 'no-store');

        if (isM3u8) {
            let m3u8Content = await response.text();
            const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
            m3u8Content = m3u8Content.split('\n').map(line => {
                line = line.trim();
                if (line && !line.startsWith('#')) {
                    let absoluteUrl = line.startsWith('http') ? line : baseUrl + line;
                    return `${host}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                }
                return line;
            }).join('\n');
            responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
            return new Response(m3u8Content, { status: 200, headers: responseHeaders });
        }

        // 剔除 ETag 和 Last-Modified，避免浏览器在使用强缓存时发送错误的 If-Range
        const headersToCopy = ['Content-Type', 'Content-Length', 'Accept-Ranges', 'Content-Range', 'Cache-Control'];
        for (const h of headersToCopy) {
            if (response.headers.has(h)) responseHeaders.set(h, response.headers.get(h));
        }
        
        // 必须 Expose 这些 Headers，否则前端浏览器或 VRChat 的播放器拿不到断点续传信息
        responseHeaders.set('Access-Control-Expose-Headers', headersToCopy.join(', '));
        if (name && isDownload) {
            responseHeaders.set("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}.mp4"`);
        }

        // 关键修复：HTTP 304 Not Modified 和 204 No Content 绝对不能携带 body（哪怕是 null 在某些 V8 版本也会报错）
        if (response.status === 204 || response.status === 304) {
            return new Response(undefined, { status: response.status, headers: responseHeaders });
        }

        return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (e) {
        // AbortError 是用户拖动进度条时浏览器主动取消的正常行为，不要返回 502 口吹浏览器
        if (e.name === 'AbortError') return new Response(null, { status: 499 });
        return new Response('Proxy Error: ' + e.message, { status: 502 });
    }
}

// --- 弹幕（VRChat 简-BiliPlayer resources=bilibarrage2 契约） ---
// 请求：GET /player/?resources=bilibarrage2&id=BVxxx&p=分P（可省）
// 返回：{ data: { TopBarrage: [{text,time}], BottomBarrage: [...], RollBarrage: [...] } }
// time 为秒（float，保留 1 位小数），用于对齐视频 currentTime。

// 极简 protobuf 解码：DmSegMobileReply.elems -> DanmakuElem。
// 真实字段（对真实 seg.so 逆向实测）：2=progress 毫秒(int32)，3=mode(int32)，7=content(string)；
// 1=id(int64，丢弃)、4=size、5=color、6=content hash(string)。注意不要用旧 XML 时代的字段表。
function parseDanmakuElems(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const elems = [];
    let p = 0;
    const rv = () => {
        // Number 累加：弹幕 progress（int32）精确；id（int64）超 2^53 会有精度损失但只用于跳过。
        let v = 0, s = 0, b;
        do { b = u8[p++]; v += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80);
        return v;
    };
    const skip = (wt) => {
        if (wt === 0) rv();
        else if (wt === 1) p += 8;
        else if (wt === 2) p += rv();
        else if (wt === 5) p += 4;
        else throw new Error('unsupported wire type: ' + wt);
    };
    // 真实响应在 elems 之后还有其它顶层字段（彩色弹幕配置等 JSON 块），
    // 对未知结构保持「尽力而为」：任何失步都停止外层循环，保留已解析的弹幕。
    while (p < u8.length) {
        let tag;
        try { tag = rv(); } catch (e) { break; }
        const fn = tag >>> 3, wt = tag & 7;
        if (fn === 1 && wt === 2) {
            // 注意求值顺序：先取长度（rv 会前移 p），再用移动后的 p 计算边界。
            const len = rv();
            const end = p + len;
            if (end > u8.length) break;
            const fields = {};
            let broken = false;
            while (p < end) {
                try {
                    const t2 = rv(), fn2 = t2 >>> 3, wt2 = t2 & 7;
                    if (wt2 === 0) fields[fn2] = rv();
                    else if (wt2 === 2) {
                        const l = rv();
                        if (p + l > u8.length) { broken = true; break; }
                        fields[fn2] = u8.subarray(p, p + l);
                        p += l;
                    }
                    else skip(wt2);
                } catch (e) { broken = true; break; }
            }
            p = end; // 无论内层是否失步，都按声明长度重新对齐
            if (!broken && fields[7] && fields[7].length) {
                elems.push({
                    text: new TextDecoder().decode(fields[7]),
                    time: (fields[2] || 0) / 1000,
                    mode: fields[3] || 1,
                    color: fields[4] || 16777215,
                });
            }
        } else {
            try { skip(wt); } catch (e) { break; }
        }
    }
    return elems;
}

function safeDecodeURIComponent(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
}

function unescapeDanmakuText(text) {
    return String(text || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, '&');
}

// --- 百度 cloudnproxy 隧道（免费静态中国出口，用于 seg.so 明文拉取） ---
// Workers 的 fetch 无法使用 CONNECT 代理，但 TCP sockets API 可以：
// connect() 到百度入口（明文 HTTP 代理，443 端口非 TLS），手写 CONNECT 头建立隧道，
// 隧道内对 api.bilibili.com:80 发明文 GET（dm seg.so 是少数 80 端口不跳 https 的端点）。
let socketsConnect = null;
try {
    socketsConnect = (await import("cloudflare:sockets")).connect;
} catch (e) { socketsConnect = null; } // Node 测试环境没有该模块，静默走既有矩阵

// 14 个静态入口，按实测延迟排序（2026-11-22 全量隧道实测）；末位为多数地区超时的广州电信边缘。
const BAIDU_ENTRIES = [
    "180.101.50.249",                     // 南京电信 376ms
    "36.155.169.188",                     // 南京移动 418ms
    "153.3.237.117",                      // 南京联通 471ms
    "180.101.50.208",                     // 南京电信 525ms
    "220.181.7.1",                        // 北京电信 609ms
    "157.0.146.158",                      // 苏州联通 612ms
    "220.181.33.174",                     // 北京电信 676ms
    "110.242.70.68",                      // 保定联通 731ms
    "183.240.98.84",                      // 广州移动 1317ms
    "163.177.17.6",                       // 广州联通 2024ms
    "220.181.111.189",                    // 北京电信 2294ms
    "163.177.17.189",                     // 广州联通 5201ms
    "110.242.70.69",                      // 保定联通 7221ms
    "14.215.182.75",                      // 广州电信（部分方向超时，兜底）
];
const BAIDU_AUTH = "1951164069";
const BAIDU_UA = "okhttp/3.11.0 SP-engine/2.71.0 Dalvik/2.1.0 (Linux; U; Android 9; HMA-AL00 Build/PQ3B.190801.002) baiduboxapp/13.33.0.11 (Baidu; P1 9)";

// 响应体若为 chunked 编码则还原
function dechunkBytes(body) {
    let out = [];
    let p = 0;
    while (p < body.length) {
        let lineEnd = -1;
        for (let i = p; i < body.length - 1; i += 1) {
            if (body[i] === 13 && body[i + 1] === 10) { lineEnd = i; break; }
        }
        if (lineEnd < 0) break;
        const size = parseInt(new TextDecoder().decode(body.slice(p, lineEnd)).split(";")[0], 16);
        if (!Number.isFinite(size) || size <= 0) break;
        const start = lineEnd + 2;
        if (start + size > body.length) break;
        out.push(body.slice(start, start + size));
        p = start + size + 2;
    }
    const total = out.reduce((a, c) => a + c.length, 0);
    const full = new Uint8Array(total);
    let off = 0;
    for (const c of out) { full.set(c, off); off += c.length; }
    return full;
}

// 经百度入口建 CONNECT 隧道，在隧道内对目标 host:port 发明文 HTTP 请求并读完整响应
async function baiduTunnelHttp(targetHost, targetPort, requestText, maxBytes) {
    if (!socketsConnect) throw new Error("sockets unavailable");
    let lastErr = null;
    // 随机起点轮换：把负载摊到所有入口上，避免单入口被高频请求标记
    const start = Math.floor(Math.random() * BAIDU_ENTRIES.length);
    const rotated = BAIDU_ENTRIES.slice(start).concat(BAIDU_ENTRIES.slice(0, start));
    for (const entry of rotated) {
        let socket;
        try {
            socket = socketsConnect({ hostname: entry, port: 443 });
            const w = socket.writable.getWriter();
            await w.write(new TextEncoder().encode("CONNECT " + targetHost + ":" + targetPort + " HTTP/1.1\r\nHost: ascdn.baidu.com\r\nX-T5-Auth: " + BAIDU_AUTH + "\r\nUser-Agent: " + BAIDU_UA + "\r\n\r\n"));
            const r = socket.readable.getReader();
            const dec = new TextDecoder();
            let head = "";
            while (!head.includes("\r\n\r\n")) {
                const { value, done } = await r.read();
                if (done) throw new Error("proxy closed during CONNECT");
                head += dec.decode(value, { stream: true });
                if (head.length > 4096) throw new Error("CONNECT head too large");
            }
            if (!/ 200 /.test(head.split("\r\n")[0])) throw new Error("CONNECT " + head.split("\r\n")[0]);
            r.releaseLock();
            w.releaseLock();
            const wr = socket.writable.getWriter();
            await wr.write(new TextEncoder().encode(requestText));
            const rd = socket.readable.getReader();
            const chunks = [];
            let total = 0;
            const cap = maxBytes || 1048576;
            while (total < cap) {
                const { value, done } = await rd.read();
                if (done) break;
                chunks.push(value);
                total += value.length;
            }
            try { await socket.close(); } catch (e) {}
            const full = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { full.set(c, off); off += c.length; }
            let headEnd = -1;
            for (let i = 0; i < full.length - 3; i += 1) {
                if (full[i] === 13 && full[i + 1] === 10 && full[i + 2] === 13 && full[i + 3] === 10) { headEnd = i; break; }
            }
            if (headEnd < 0) throw new Error("no http head");
            const headText = new TextDecoder().decode(full.slice(0, headEnd));
            let body = full.slice(headEnd + 4);
            if (/transfer-encoding:\s*chunked/i.test(headText)) body = dechunkBytes(body);
            return { entry: entry, status: headText.split("\r\n")[0], body: body };
        } catch (e) {
            lastErr = e;
            try { if (socket) await socket.close(); } catch (e2) {}
        }
    }
    throw lastErr || new Error("baidu tunnel failed");
}

const MAX_DANMAKU_SEGMENTS = 40;

// VRChat VRCStringDownloader / VRCHttpClient 的响应大小上限约 1MB：
// 超长视频（弹幕上万条）按比例均匀抽样，保留完整时间轴覆盖。
const MAX_DANMAKU_ITEMS = 10000;
function capDanmakuList(list, budget) {
    if (list.length <= budget) return list;
    const step = list.length / budget;
    const out = [];
    for (let i = 0; i < budget; i += 1) out.push(list[Math.floor(i * step)]);
    return out;
}

// 二进制（protobuf）API 的多通道抓取：EO 直连 → Vercel 代理 → 官方域名直连。
// 风控体（HTML 以 '<' 开头 / JSON 错误以 '{' 开头）换下一通道；空体视为合法空分段。
// 全部被风控时返回最后一个候选（parseDanmakuElems 会安全产出 0 条）。
async function fetchBiliBinary(url, options) {
    const official = toOfficialApi(url);
    const candidates = [];
    if (official) {
        candidates.push({ url, via: 'direct' });
        for (const cfg of apiProxyConfigs()) candidates.push({ url: official, via: 'proxy', cfg });
        candidates.push({ url: official, via: 'direct' });
    } else {
        for (const cfg of apiProxyConfigs()) candidates.push({ url, via: 'proxy', cfg });
        candidates.push({ url, via: 'direct' });
    }
    let last = null;
    const tried = [];
    for (const candidate of orderCandidates(candidates)) {
        let res;
        try {
            res = candidate.via === 'proxy' ? await proxyApiFetch(candidate.url, options, candidate.cfg) : await fetch(candidate.url, options);
        } catch (e) {
            markTransport(candidate, candidate.url, false);
            tried.push({ via: candidate.via, cfg: candidate.cfg ? candidate.cfg.base.slice(8, 40) : null, fatal: String(e.message || e).slice(0, 60) });
            continue;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        const head = buf.length ? buf[0] : -1;
        tried.push({ via: candidate.via, cfg: candidate.cfg ? candidate.cfg.base.slice(8, 40) : null, status: res.status, bytes: buf.length, head });
        const healthy = res.ok && head !== 0x3c && head !== 0x7b;
        markTransport(candidate, candidate.url, healthy);
        if (healthy) return { res, buf, tried };
        last = { res, buf, tried };
    }
    if (last) return last;
    throw new AntiCrawlError();
}

// cid + duration 来自 pagelist（轻端点，EO 上最稳）；seg.so 按 6 分钟分段并行拉取。
async function resolveBarrage(bvid, page, debug) {
    const cookie = await getAntiCrawlCookie();
    const headers = { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie };

    let cid = 0, duration = 0;
    let barrageMeta = { title: '', owner: '' };
    try {
        const vData = await fetchBiliJson(biliApi(`/x/web-interface/view?bvid=${bvid}`), { headers });
        if (vData.code === 0) {
            const vpages = Array.isArray(vData.data.pages) && vData.data.pages.length ? vData.data.pages : null;
            const item = vpages && vpages[page - 1] ? vpages[page - 1] : vData.data;
            cid = Number(item.cid) || 0;
            duration = Number(item.duration) || 0;
            barrageMeta = {
                title: String(vData.data.title || ''),
                owner: vData.data.owner ? String(vData.data.owner.name || '') : '',
            };
        }
    } catch (e) { /* 回落到 pagelist */ }
    if (!cid) {
        try {
            const pl = await fetchBiliJson(biliApi(`/x/player/pagelist?bvid=${bvid}`), { headers });
            if (pl && pl.code === 0 && Array.isArray(pl.data) && pl.data.length) {
                const item = pl.data[page - 1] || pl.data[0];
                cid = Number(item && item.cid) || 0;
                duration = Number(item && item.duration) || 0;
                barrageMeta = { title: String(item && item.part || ''), owner: '' };
            }
        } catch (e) { /* 两者皆失败则报错 */ }
    }
    if (!cid) throw new Error('未找到弹幕数据');

    const segments = Math.min(Math.max(1, Math.ceil(duration / 360) || 1), MAX_DANMAKU_SEGMENTS);
    const elems = [];
    const batchSize = 8;
    for (let start = 1; start <= segments; start += batchSize) {
        const indexes = [];
        for (let i = start; i < start + batchSize && i <= segments; i += 1) indexes.push(i);
        const buffers = await Promise.all(indexes.map(async (i) => {
            // 主通道：百度隧道明文拉 seg.so（免费静态中国出口）
            if (socketsConnect) {
                try {
                    const reqText = "GET /x/v2/dm/web/seg.so?type=1&oid=" + cid + "&pid=0&segment_index=" + i + " HTTP/1.1\r\nHost: api.bilibili.com\r\nUser-Agent: " + UA + "\r\nReferer: " + REFERER + "\r\nCookie: " + (headers.Cookie || "") + "\r\nConnection: close\r\n\r\n";
                    const out = await Promise.race([
                        baiduTunnelHttp("api.bilibili.com", 80, reqText, 1048576),
                        new Promise((_, rej) => setTimeout(() => rej(new Error("baidu tunnel timeout")), 8000)),
                    ]);
                    if (/ 200 /.test(out.status) && out.body && out.body.length) {
                        if (debug && i === indexes[0]) debug.push({ segment: i, via: "baidu:" + out.entry, status: 200, bytes: out.body.length });
                        const elemsSeg = parseDanmakuElems(out.body);
                        return { elems: elemsSeg };
                    }
                    if (debug && i === indexes[0]) debug.push({ segment: i, via: "baidu", status: out.status, bytes: out.body ? out.body.length : 0 });
                } catch (e) {
                    if (debug && i === indexes[0]) debug.push({ segment: i, via: "baidu", fatal: String(e.message || e).slice(0, 60) });
                }
            }
            // 备用：既有矩阵（EO 直连 → blue 代理 → 官方域名）
            try {
                const out = await fetchBiliBinary(biliApi(`/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=0&segment_index=${i}`), { headers });
                if (debug && i === indexes[0]) debug.push({ segment: i, via: "matrix", tried: out.tried });
                return out.buf.length ? { buf: out.buf } : null;
            } catch (e) { return null; }
        }));
        for (const b of buffers) {
            if (!b) continue;
            if (b.elems) { elems.push(...b.elems); continue; }
            if (b.buf) {
                try { elems.push(...parseDanmakuElems(b.buf)); } catch (e) { /* 跳过坏段 */ }
            }
        }

    }

    // 与 bil.ouo.chat 同款响应格式（简-BiliPlayer Udon 逐字段核对的 ground truth）：
    // time 为 5 位小数字符串，text 包 <color=#RRGGBB> Unity 富文本（颜色来自弹幕 color 字段）。
    const colorTag = (color, text) => '<color=#' + (Number(color) >>> 0).toString(16).padStart(6, '0').toUpperCase() + '>' + text + '</color>';
    const RollBarrage = [], BottomBarrage = [], TopBarrage = [];
    for (const el of elems) {
        if (!el.text) continue;
        const item = { time: el.time.toFixed(5), text: colorTag(el.color, el.text) };
        if (el.mode === 4) BottomBarrage.push(item);
        else if (el.mode === 5) TopBarrage.push(item);
        else if ((el.mode >= 1 && el.mode <= 3) || el.mode === 6) RollBarrage.push(item);
        // 7/8/9（特殊/高级弹幕）丢弃
    }
    const byTime = (a, b) => Number(a.time) - Number(b.time);
    RollBarrage.sort(byTime);
    BottomBarrage.sort(byTime);
    TopBarrage.sort(byTime);
    let data = { RollBarrage, BottomBarrage, TopBarrage };
    const total = RollBarrage.length + BottomBarrage.length + TopBarrage.length;
    if (total > MAX_DANMAKU_ITEMS) {
        const ratio = MAX_DANMAKU_ITEMS / total;
        data = {
            RollBarrage: capDanmakuList(RollBarrage, Math.max(1, Math.floor(RollBarrage.length * ratio))),
            BottomBarrage: capDanmakuList(BottomBarrage, Math.max(1, Math.floor(BottomBarrage.length * ratio))),
            TopBarrage: capDanmakuList(TopBarrage, Math.max(1, Math.floor(TopBarrage.length * ratio))),
        };
    }
    const result = {
        code: 200,
        title: barrageMeta.title,
        owner: barrageMeta.owner,
        bv: bvid,
        cid: cid,
        p: String(page),
        data: data,
    };
    if (Array.isArray(debug)) result.__trace = debug;
    return result;
}

export default {
    async fetch(request, env, ctx) {
        WORKER_ENV = env || {};
        const url = new URL(request.url);
        const host = url.origin;
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': '*' } });
        }

        // /live/房间号 直链入口
        const liveMatch = path.match(/^\/live\/(\d+)$/);
        if (liveMatch) {
            try {
                const res = await resolveLive(liveMatch[1], host);
                return Response.redirect(res.downloadUrl, 302);
            } catch (e) {
                return new Response(`Error: ${e.message}`, { status: 500 });
            }
        }

        // VRChat 简-BiliPlayer 弹幕接口。Udon 侧只用字符串拼接（程序堆里没有 &id= 字面量），
        // 实际请求可能是 ?resources=bilibarrage2&id=BV、?resources=bilibarrage2?id=BV、
        // 甚至把 BV 直接粘在 resources 值后面。与原版服务器一致地宽容解析：
        // 整条查询串包含 bilibarrage2 即视为弹幕请求，BV 号和分 P 从整条查询串中提取。
        if (path === '/player' || path === '/player/') {
            const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
            const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : (url.search || '');
            if (!rawQuery.toLowerCase().includes('bilibarrage2')) {
                // /player/?url=<B站链接/BV号> —— VRChat 电视直连播放入口：
                // 播放器无法解析 JSON，返回 302 跳到 /proxy 媒体流（支持 Range）。
                // 仅在带 url= 参数时触发；其它 resources 类型（musicimage 等）不受影响。
                const urlMatch = rawQuery.match(/url=([^&]*)/);
                const urlText = urlMatch ? safeDecodeURIComponent(urlMatch[1]) : '';
                const bv = urlMatch ? ((rawQuery.match(/(BV[a-zA-Z0-9]{10})/) || (urlText.match(/(BV[a-zA-Z0-9]{10})/) || []))[1]) : null;
                if (bv) {
                    const qn = parseInt((rawQuery.match(/qn=(\d+)/) || [])[1] || '116', 10) || 116;
                    try {
                        const res = await resolveVideo(bv, qn, host);
                        return Response.redirect(res.playableUrl, 302);
                    } catch (e) {
                        const message = (e instanceof AntiCrawlError || e.name === 'AntiCrawlError') ? ANTI_CRAWL_MSG : e.message;
                        return new Response(JSON.stringify({ status: 'error', message }), { status: 200, headers: jsonHeaders });
                    }
                }
                return new Response(JSON.stringify({ status: 'error', message: '不支持的 resources 类型' }), { status: 200, headers: jsonHeaders });
            }
            const bv = (rawQuery.match(/(BV[a-zA-Z0-9]{10})/) || [])[1];
            if (!bv) return new Response(JSON.stringify({ status: 'error', message: '无效的 BV 号' }), { status: 200, headers: jsonHeaders });
            const p = parseInt((rawQuery.match(/(?:\?|&)p=(\d+)/) || [])[1] || '1', 10) || 1;
            try {
                const debug = url.searchParams.get('debug') === '1' ? [] : null;
                const bar = await resolveBarrage(bv, p, debug);
                const __trace = bar.__trace;
                delete bar.__trace;
                return new Response(JSON.stringify(debug ? Object.assign({}, bar, { trace: __trace }) : bar), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...(debug ? {} : { 'Cache-Control': 'public, max-age=600' }) } });
            } catch (e) {
                return new Response(JSON.stringify({ status: 'error', message: e.message }), { status: 200, headers: jsonHeaders });
            }
        }

        if (path === '/proxy') return handleProxy(request, url, host);
        if (path === '/' || path === '') return new Response(UI(host), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

        // 版本探针：用于确认 CF Worker 是否已部署最新代码
        if (path === '/v') return new Response(JSON.stringify({
            version: VERSION,
            VERCEL_PROXY: WORKER_ENV.VERCEL_PROXY ? '✅ 已配置' : '❌ 未配置',
            PROXY_TOKEN: WORKER_ENV.PROXY_TOKEN ? '✅ 已配置' : '❌ 未配置',
        }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

        // 全局文案/链接直连入口：支持在域名后直接粘贴 B 站分享文案或链接（包含 BV 或 b23.tv 短链）
        // 例如：https://bili.yamadaryo.me/【xxx】https://www.bilibili.com/video/BV1...
        const decodedPath = decodeURIComponent(path);
        const bvMatch = decodedPath.match(/(BV[a-zA-Z0-9]{10})/i);
        const b23Match = decodedPath.match(/b23\.tv\/([a-zA-Z0-9]+)/i);
        const liveRoomMatch = decodedPath.match(/live\.bilibili\.com\/(\d+)/i);

        if (!path.startsWith('/api/') && !path.startsWith('/proxy') && !path.startsWith('/v') && path !== '/') {
            if (liveRoomMatch) {
                try {
                    const res = await resolveLive(liveRoomMatch[1], host);
                    return Response.redirect(res.downloadUrl, 302);
                } catch (e) {
                    return new Response(JSON.stringify({ status: 'error', message: e.message }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
            }

            if (bvMatch || b23Match) {
                let finalBvid = bvMatch ? bvMatch[1] : null;
                if (b23Match && !finalBvid) {
                    try {
                        const res = await fetch(`https://b23.tv/${b23Match[1]}`, { method: 'GET', redirect: 'manual' });
                        if (res.status >= 300 && res.status < 400) {
                            const loc = res.headers.get('location');
                            finalBvid = loc?.match(/(BV[a-zA-Z0-9]{10})/i)?.[1];
                            const shortLiveMatch = loc?.match(/live\.bilibili\.com\/(\d+)/i);
                            if (shortLiveMatch && !finalBvid) {
                                const resLive = await resolveLive(shortLiveMatch[1], host);
                                return Response.redirect(resLive.downloadUrl, 302);
                            }
                        }
                    } catch (e) {}
                }

                if (finalBvid) {
                    // 浏览器直开：跳转到带弹幕的播放页，而不是裸流
                    return Response.redirect(host + '/?text=' + encodeURIComponent(finalBvid), 302);
                    try {
                        const res = await resolveVideo(finalBvid, qn, host);
                        return Response.redirect(res.downloadUrl, 302);
                    } catch (e) {
                        const message = (e instanceof AntiCrawlError || e.name === 'AntiCrawlError') ? ANTI_CRAWL_MSG : e.message;
                        return new Response(JSON.stringify({ status: 'error', message }), {
                            status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                        });
                    }
                }
            }
        }

        // 视频 API
        if (path === '/api/video') {
            let text = url.searchParams.get('text');
            const qn = parseInt(url.searchParams.get('qn')) || 116;
            if (!text) return new Response(JSON.stringify({ status: 'error', message: 'Missing text' }), { status: 400 });

            // 尝试解析 b23.tv 短链
            const b23Match = text.match(/b23\.tv\/([a-zA-Z0-9]+)/);
            if (b23Match) {
                try {
                    const res = await fetch(`https://b23.tv/${b23Match[1]}`, { method: 'GET', redirect: 'manual' });
                    if (res.status >= 300 && res.status < 400) {
                        text = res.headers.get('location') || text;
                    }
                } catch (e) {
                    // 忽略短链解析失败，交由后续的 BV 号匹配来判断
                }
            }

            const bvMatch = text.match(/(BV[a-zA-Z0-9]{10})/);
            if (!bvMatch) return new Response(JSON.stringify({ status: 'error', message: '无效的 BV 号' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

            try {
                const res = await resolveVideo(bvMatch[1], qn, host);
                return new Response(JSON.stringify({ status: 'success', ...res }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
                });
            } catch (e) {
                // 反爬异常统一映射为中文提示；其它异常保留原 message（如 ERROR_MAP 业务码错误）。
                const message = (e instanceof AntiCrawlError || e.name === 'AntiCrawlError') ? ANTI_CRAWL_MSG : e.message;
                return new Response(JSON.stringify({ status: 'error', message }), {
                    status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // 直播 API
        if (path === '/api/live') {
            let room = url.searchParams.get('room');
            if (!room) return new Response(JSON.stringify({ status: 'error', message: 'Missing room' }), { status: 400 });

            // 尝试解析 b23.tv 短链
            const b23Match = room.match(/b23\.tv\/([a-zA-Z0-9]+)/);
            if (b23Match) {
                try {
                    const res = await fetch(`https://b23.tv/${b23Match[1]}`, { method: 'GET', redirect: 'manual' });
                    if (res.status >= 300 && res.status < 400) {
                        room = res.headers.get('location') || room;
                    }
                } catch (e) {}
            }

            // 提取房间号：优先匹配 live.bilibili.com/数字，否则直接匹配纯数字
            const roomId = room.match(/live\.bilibili\.com\/(\d+)/)?.[1] || room.match(/(?<![a-zA-Z])(\d+)(?![a-zA-Z])/)?.[1] || room.match(/(\d+)/)?.[1];
            if (!roomId) return new Response(JSON.stringify({ status: 'error', message: '无效的房间号' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

            try {
                const res = await resolveLive(roomId, host);
                return new Response(JSON.stringify({ status: 'success', ...res }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ status: 'error', message: e.message }), {
                    status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        return new Response('Not Found', { status: 404 });
    }
}

// --- Named exports for testing (non-behavioral) ---
// Existing functions are exported as-is so tests can drive them directly with a
// mocked fetch. The `export default` Worker handler above is unchanged.
export { resolveVideo, getPlayUrlWithFallback, signWbi, getMixinKeyFromNav, appSign, getBuvid, getAntiCrawlCookie, AntiCrawlError, ANTI_CRAWL_MSG, fetchBiliJson, resolveBarrage, parseDanmakuElems, resetTransportHealth };
