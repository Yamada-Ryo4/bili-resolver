/**
 * Bilibili Resolver & Proxy Worker (v3.2)
 * 
 * 双模式界面：视频 / 直播 切换
 * - 视频：原版逻辑 (1080P/720P/480P, Quest模式, 历史记录)
 * - 直播：v4.1 稳定版本 (CN/OV 节点检测)
 */

const REFERER = 'https://www.bilibili.com/';
const LIVE_REFERER = 'https://live.bilibili.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const ERROR_MAP = {
    '-400': '请求错误', '-403': '访问权限不足', '-404': '视频不存在',
    '-10403': '仅限港澳台地区', '62002': '视频不可见', '62004': '审核中'
};

// --- Buvid ---
async function getBuvid() {
    try {
        const res = await fetch("https://api.bilibili.com/x/frontend/finger/spi", { headers: { "User-Agent": UA } });
        const json = await res.json();
        return json.data?.b_3 || "FE6D3664-927F-F75B-B7D4-733E5D4B263F69428infoc";
    } catch (e) { return "FE6D3664-927F-F75B-B7D4-733E5D4B263F69428infoc"; }
}

// --- WBI 签名 ---
const mixinKeyEncTab = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const getMixinKey = (orig) => mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
async function md5(text) {
    const hashBuffer = await crypto.subtle.digest('MD5', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function signWbi(params) {
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: { "User-Agent": UA } });
    const json = await res.json();
    const { img_url, sub_url } = json.data.wbi_img;
    const mixin_key = getMixinKey(img_url.split('/').pop().split('.')[0] + sub_url.split('/').pop().split('.')[0]);
    const curr_params = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(curr_params).sort().map(k => `${k}=${encodeURIComponent(curr_params[k])}`).join('&');
    return query + `&w_rid=${await md5(query + mixin_key)}`;
}

// --- 视频解析 (原版) ---
async function getPlayUrlWithFallback(bvid, cid, targetQn) {
    const qualities = [targetQn, 80, 64, 32].filter((v, i, a) => a.indexOf(v) === i && v <= targetQn);
    let lastError = null;
    for (const qn of qualities) {
        try {
            const signedQuery = await signWbi({ bvid, cid, qn: qn, fnval: 1 });
            const pRes = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${signedQuery}`, {
                headers: { 'User-Agent': UA, 'Referer': REFERER }
            });
            const pData = await pRes.json();
            if (pData.code === 0 && pData.data.durl?.[0]) {
                return { url: pData.data.durl[0].url, quality: pData.data.quality };
            } else { lastError = pData.message || ERROR_MAP[pData.code]; }
        } catch (e) { lastError = e.message; }
    }
    throw new Error(lastError || "视频解析失败");
}

async function resolveVideo(bvid, qn, host) {
    const vRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { 'User-Agent': UA } });
    const vData = await vRes.json();
    if (vData.code !== 0) throw new Error(ERROR_MAP[vData.code] || vData.message);

    const { cid, title, pic, owner } = vData.data;
    const videoStream = await getPlayUrlWithFallback(bvid, cid, qn || 116);

    const playableUrl = `${host}/proxy?url=${encodeURIComponent(videoStream.url)}&name=${encodeURIComponent(title)}`;
    const downloadUrl = `${playableUrl}&dl=1`;

    return { title, pic, bvid, author: owner.name, playableUrl, downloadUrl, quality: videoStream.quality, isLive: false };
}

// --- 直播解析 (v4.1) ---
async function resolveLive(roomId, host) {
    const infoRes = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
        headers: { 'User-Agent': UA, 'Referer': LIVE_REFERER }
    });
    const infoData = await infoRes.json();
    if (infoData.code !== 0) throw new Error("直播间不存在");

    const { title, user_cover, keyframe, live_status, room_id: realRoomId, uid } = infoData.data;
    if (live_status !== 1) throw new Error("主播未开播");

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
            const res = await fetch(api, { headers: getHeaders() });
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
            const res = await fetch(api, { headers: getHeaders() });
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

    const isHLS = result.url.includes('.m3u8');
    const formatStr = `${isHLS ? 'HLS' : 'FLV'} (${result.nodeType})`;
    const proxyUrl = `${host}/proxy?url=${encodeURIComponent(result.url)}`;

    return {
        title,
        pic: user_cover || keyframe,
        author: `UID:${uid}`,
        playableUrl: proxyUrl,
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
    <title>Bilibili 解析</title>
    <script src="https://cdn.tailwindcss.com"></script>
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
                <div class="flex gap-4 items-start">
                    <img id="resPic" referrerpolicy="no-referrer" class="w-28 h-16 object-cover rounded-lg shadow-md bg-slate-800 shrink-0">
                    <div class="min-w-0 flex-1 space-y-1">
                        <h3 id="resTitle" class="text-sm font-bold leading-tight line-clamp-2"></h3>
                        <div class="flex items-center gap-2">
                            <span id="resTag" class="text-[10px] bg-pink-500/20 text-pink-300 px-1.5 py-0.5 rounded font-bold uppercase">VIDEO</span>
                            <span id="resQuality" class="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">1080P</span>
                        </div>
                    </div>
                </div>
                <div class="relative">
                    <input id="link" readonly class="w-full bg-slate-900/40 border border-slate-700/50 rounded-xl px-4 py-3 text-xs text-slate-300 outline-none font-mono tracking-tight">
                    <button onclick="copyLink()" class="absolute right-2 top-2 bg-slate-700/50 hover:bg-slate-600 text-xs px-3 py-1 rounded-lg">复制</button>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <a id="btnPreview" target="_blank" class="flex items-center justify-center bg-slate-700/50 hover:bg-slate-700 py-3 rounded-xl text-sm font-bold">预览</a>
                    <a id="btnDownload" href="#" class="flex items-center justify-center bg-gradient-to-r from-pink-600 to-rose-600 py-3 rounded-xl text-sm font-bold shadow-lg active:scale-95">下载</a>
                </div>
            </div>
        </div>

        <!-- 历史记录 (仅视频) -->
        <div id="historyArea" class="hidden mt-6 glass rounded-3xl p-5">
            <h4 class="text-xs font-bold text-slate-500 uppercase mb-3 flex justify-between"><span>最近解析</span><span onclick="clearHistory()" class="cursor-pointer hover:text-white">清除</span></h4>
            <div id="historyList" class="space-y-2"></div>
        </div>

        <p class="text-center text-[10px] text-slate-600 mt-4">VRChat 直链: ${host}/live/房间号</p>
    </div>

    <div id="toast" class="toast">消息</div>

    <script>
        let currentMode = 'video';

        function setMode(mode) {
            currentMode = mode;
            document.getElementById('videoPanel').classList.toggle('hidden', mode !== 'video');
            document.getElementById('livePanel').classList.toggle('hidden', mode !== 'live');
            document.getElementById('modeVideo').classList.toggle('active', mode === 'video');
            document.getElementById('modeLive').classList.toggle('active', mode === 'live');
            document.getElementById('modeVideo').classList.toggle('text-slate-400', mode !== 'video');
            document.getElementById('modeLive').classList.toggle('text-slate-400', mode !== 'live');
            document.getElementById('result').classList.add('hidden');
            document.getElementById('historyArea').classList.toggle('hidden', mode !== 'video' || !hasHistory());
        }

        function hasHistory() { return JSON.parse(localStorage.getItem('bili_history') || '[]').length > 0; }

        function showToast(msg, warn = false) { 
            const t = document.getElementById('toast'); 
            t.innerText = msg; 
            t.className = 'toast show' + (warn ? ' warn' : '');
            setTimeout(() => t.className = 'toast', 4000); 
        }
        function copyLink() { document.getElementById('link').select(); document.execCommand('copy'); showToast('已复制'); }

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

        async function parseVideo() {
            const input = document.getElementById('videoInput').value;
            const isQuest = document.getElementById('questMode').checked;
            const qn = isQuest ? 64 : document.getElementById('videoQn').value;
            if (!input) { showToast('请输入内容'); return; }
            
            document.getElementById('loader').classList.remove('hidden'); 
            document.getElementById('result').classList.add('hidden');
            document.getElementById('bg-cover').style.opacity = '0';

            try {
                const res = await fetch(\`/api/video?text=\${encodeURIComponent(input)}&qn=\${qn}\`);
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
                const res = await fetch(\`/api/live?room=\${encodeURIComponent(input)}\`);
                const data = await res.json();
                if (data.status === 'success') {
                    showResult(data, false);
                    if (data.nodeType === 'OV') {
                        showToast('⚠️ OV 节点可能无法播放，请重试', true);
                    }
                } else showToast(data.message);
            } catch (e) { showToast('请求失败'); } 
            finally { document.getElementById('loader').classList.add('hidden'); }
        }

        function showResult(data, isQuest) {
            const pic = data.pic.replace('http:', 'https:');
            document.getElementById('resPic').src = pic;
            document.getElementById('bg-cover').style.backgroundImage = \`url('\${pic}')\`;
            document.getElementById('bg-cover').style.opacity = '0.4';
            document.getElementById('resTitle').innerText = data.title;
            
            const tag = document.getElementById('resTag');
            const qn = document.getElementById('resQuality');
            const btnDl = document.getElementById('btnDownload');
            const link = document.getElementById('link');
            
            if (data.isLive) {
                tag.innerText = 'LIVE';
                tag.className = 'text-[10px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded font-bold uppercase';
                qn.innerText = data.format;
                link.value = data.downloadUrl;  // 直播显示原始直链
                document.getElementById('btnPreview').href = data.downloadUrl;  // 直播预览也用直链
                btnDl.innerText = '复制直链';
                btnDl.href = '#';
                btnDl.onclick = (e) => { e.preventDefault(); navigator.clipboard.writeText(data.downloadUrl); showToast('直链已复制'); };
            } else {
                tag.innerText = 'VIDEO';
                tag.className = 'text-[10px] bg-pink-500/20 text-pink-300 px-1.5 py-0.5 rounded font-bold uppercase';
                const qnMap = { 116: '1080P+', 80: '1080P', 64: '720P', 32: '480P' };
                qn.innerText = isQuest ? 'Quest' : (qnMap[data.quality] || 'MP4');
                link.value = data.playableUrl;
                document.getElementById('btnPreview').href = data.playableUrl;
                btnDl.innerText = '下载';
                btnDl.href = data.downloadUrl;
                btnDl.onclick = null;
            }
            
            document.getElementById('result').classList.remove('hidden');
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
    try {
        const targetUrl = new URL(target);
        if (!targetUrl.hostname.includes('bilivideo') && !targetUrl.hostname.includes('hdslb') && !targetUrl.hostname.includes('akamaized')) {
            return new Response('Forbidden', { status: 403 });
        }
    } catch (e) { return new Response('Invalid URL', { status: 400 }); }

    const isM3u8 = target.includes('.m3u8');
    const isLive = target.includes('live-bvc') || isM3u8;

    const newHeaders = new Headers({
        'Referer': isLive ? LIVE_REFERER : REFERER,
        'User-Agent': isLive ? UA_MOBILE : UA,
        'Origin': isLive ? 'https://live.bilibili.com' : 'https://www.bilibili.com'
    });
    if (request.headers.has("Range")) newHeaders.set("Range", request.headers.get("Range"));

    try {
        const response = await fetch(target, { headers: newHeaders });
        if (!response.ok) {
            return new Response(`CDN Error: ${response.status}`, { status: response.status });
        }

        const responseHeaders = new Headers();
        responseHeaders.set("Access-Control-Allow-Origin", "*");

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

        if (response.headers.has('Content-Type')) responseHeaders.set('Content-Type', response.headers.get('Content-Type'));
        if (response.headers.has('Content-Length')) responseHeaders.set('Content-Length', response.headers.get('Content-Length'));
        if (name && isDownload) {
            responseHeaders.set("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}.mp4"`);
        }

        return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (e) {
        return new Response(`Proxy Error: ${e.message}`, { status: 502 });
    }
}

export default {
    async fetch(request, env, ctx) {
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

        if (path === '/proxy') return handleProxy(request, url, host);
        if (path === '/' || path === '') return new Response(UI(host), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

        // 视频 API
        if (path === '/api/video') {
            const text = url.searchParams.get('text');
            const qn = parseInt(url.searchParams.get('qn')) || 80;
            if (!text) return new Response(JSON.stringify({ status: 'error', message: 'Missing text' }), { status: 400 });

            const bvMatch = text.match(/(BV[a-zA-Z0-9]{10})/);
            if (!bvMatch) return new Response(JSON.stringify({ status: 'error', message: '无效的 BV 号' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

            try {
                const cache = caches.default;
                const cacheKey = new Request(url.toString(), request);
                let response = await cache.match(cacheKey);
                if (!response) {
                    const res = await resolveVideo(bvMatch[1], qn, host);
                    response = new Response(JSON.stringify({ status: 'success', ...res }), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=1200' }
                    });
                    ctx.waitUntil(cache.put(cacheKey, response.clone()));
                }
                return response;
            } catch (e) {
                return new Response(JSON.stringify({ status: 'error', message: e.message }), {
                    status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // 直播 API
        if (path === '/api/live') {
            const room = url.searchParams.get('room');
            if (!room) return new Response(JSON.stringify({ status: 'error', message: 'Missing room' }), { status: 400 });

            const roomId = room.match(/(\d+)/)?.[1];
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
