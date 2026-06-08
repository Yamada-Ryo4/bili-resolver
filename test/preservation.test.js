/**
 * Task 3 — Preservation Property Tests (Property 2)
 *
 * OBSERVATION-FIRST. These tests encode the REAL, observed behavior of the
 * CURRENT (UNFIXED) code for inputs where the bug condition does NOT hold
 * (isBugCondition == false). They MUST PASS on the unfixed code: they establish
 * the baseline behavior that the anti-crawl fix (task 4) must preserve.
 *
 * Property 2: Preservation — 非反爬输入行为不变.
 *   For any input where isBugCondition returns false, the resolver SHALL produce
 *   the same result before and after the fix. This file fixes the "before"
 *   behavior for: happy-path video, live resolution, invalid BV, ERROR_MAP
 *   business codes, cache hit, and the /proxy handler (whitelist, Range
 *   pass-through, m3u8 rewrite).
 *
 * DO NOT modify index.js to make these pass — they document existing behavior.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import workerDefault, { resolveVideo } from '../index.js';

const HOST = 'https://worker.test';
const BVID = 'BVxxxxxxxxxx'; // matches /BV[a-zA-Z0-9]{10}/

// Realistic Bilibili wbi_img basenames: two 32-char hex strings whose
// concatenation is 64 chars, satisfying getMixinKey's index table (max 63).
const IMG_URL = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB_URL = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';

// Mirror of index.js ERROR_MAP (not exported) so we can assert observed mapping.
const ERROR_MAP = {
    '-400': '请求错误', '-403': '访问权限不足', '-404': '视频不存在',
    '-10403': '仅限港澳台地区', '62002': '视频不可见', '62004': '审核中',
};
const KNOWN_CODES = Object.keys(ERROR_MAP).map(Number);

// Live-chain endpoint keyword fragments (not in ENDPOINTS, supplied directly).
const LIVE_GET_INFO = 'Room/get_info';
const LIVE_PLAYURL_LEGACY = 'Room/playUrl';
const LIVE_PLAYURL_V2 = 'getRoomPlayInfo';

const ctxNoop = { waitUntil() {} };

// ---------------------------------------------------------------------------
// 1. Happy-path video — resolveVideo returns the documented success shape.
// ---------------------------------------------------------------------------
describe('Preservation 1: happy-path video resolveVideo() shape & fields', () => {
    it('returns {title, pic, bvid, author, playableUrl, downloadUrl, quality, isLive:false}', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    title: fc.string(),
                    pic: fc.string(),
                    author: fc.string(),
                    cid: fc.integer({ min: 1, max: 2_000_000_000 }),
                    quality: fc.constantFrom(16, 32, 64, 80, 112, 116, 120),
                    durlUrl: fc.webUrl(),
                    qn: fc.constantFrom(116, 80, 64, 32),
                }),
                async ({ title, pic, author, cid, quality, durlUrl, qn }) => {
                    installFetchMock({
                        [ENDPOINTS.FINGER_SPI]: () => makeResponse({ data: { b_3: 'BUVID3', b_4: 'BUVID4' } }),
                        [ENDPOINTS.NAV]: () => makeResponse({ data: { wbi_img: { img_url: IMG_URL, sub_url: SUB_URL } } }),
                        [ENDPOINTS.VIEW]: () => makeResponse({
                            code: 0,
                            data: { cid, title, pic, owner: { name: author } },
                        }),
                        [ENDPOINTS.PLAYURL]: () => makeResponse({
                            code: 0,
                            data: { quality, durl: [{ url: durlUrl }] },
                        }),
                    });

                    const result = await resolveVideo(BVID, qn, HOST);

                    const playableUrl = `${HOST}/proxy?url=${encodeURIComponent(durlUrl)}&name=${encodeURIComponent(title)}`;
                    expect(result).toEqual({
                        title,
                        pic,
                        bvid: BVID,
                        author,
                        playableUrl,
                        downloadUrl: `${playableUrl}&dl=1`,
                        quality,
                        isLive: false,
                    });
                },
            ),
            { numRuns: 60 },
        );
    });
});

// ---------------------------------------------------------------------------
// 2. Live resolution — /api/live success shape via the worker default handler.
// ---------------------------------------------------------------------------
describe('Preservation 2: live resolution via /api/live (Legacy chain)', () => {
    it('returns the documented live success body (CN/OV node + FLV/HLS format)', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    title: fc.string(),
                    coverStr: fc.string({ minLength: 1 }),
                    keyframe: fc.string({ minLength: 1 }),
                    hasCover: fc.boolean(),
                    uid: fc.integer({ min: 1, max: 2_000_000_000 }),
                    roomId: fc.integer({ min: 1, max: 99_999_999 }),
                    streamId: fc.integer({ min: 1, max: 999_999 }),
                    isCN: fc.boolean(),
                    isHLS: fc.boolean(),
                }),
                async ({ title, coverStr, keyframe, hasCover, uid, roomId, streamId, isCN, isHLS }) => {
                    const user_cover = hasCover ? coverStr : '';
                    const base = isCN ? 'https://cn-gotcha04.bilivideo.com' : 'https://ov-gotcha04.bilivideo.com';
                    const ext = isHLS ? '.m3u8' : '.flv';
                    const streamUrl = `${base}/live/${streamId}${ext}`;

                    installFetchMock({
                        [LIVE_GET_INFO]: () => makeResponse({
                            code: 0,
                            data: {
                                title,
                                user_cover,
                                keyframe,
                                live_status: 1,
                                room_id: roomId,
                                uid,
                            },
                        }),
                        [ENDPOINTS.FINGER_SPI]: () => makeResponse({ data: { b_3: 'BUVID3', b_4: 'BUVID4' } }),
                        [LIVE_PLAYURL_LEGACY]: () => makeResponse({
                            code: 0,
                            data: { durl: [{ url: streamUrl }] },
                        }),
                        [LIVE_PLAYURL_V2]: () => makeResponse({ code: 0, data: {} }),
                    });

                    const request = new Request(`${HOST}/api/live?room=${roomId}`);
                    const response = await workerDefault.fetch(request, {}, ctxNoop);
                    const body = await response.json();

                    const nodeType = isCN ? 'CN' : 'OV';
                    const format = `${isHLS ? 'HLS' : 'FLV'} (${nodeType})`;
                    expect(body).toEqual({
                        status: 'success',
                        title,
                        pic: user_cover || keyframe,
                        author: `UID:${uid}`,
                        playableUrl: `${HOST}/proxy?url=${encodeURIComponent(streamUrl)}`,
                        downloadUrl: streamUrl,
                        quality: 0,
                        isLive: true,
                        format,
                        nodeType,
                    });
                },
            ),
            { numRuns: 50 },
        );
    });
});

// ---------------------------------------------------------------------------
// 3. Invalid BV — /api/video returns { status:'error', message:'无效的 BV 号' }.
// ---------------------------------------------------------------------------
describe('Preservation 3: invalid BV number', () => {
    it('returns 无效的 BV 号 with status 200 and never hits the network', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 32 }).filter((s) => !/(BV[a-zA-Z0-9]{10})/.test(s)),
                async (text) => {
                    const fetchFn = installFetchMock({}); // any call throws -> proves no network use
                    const request = new Request(`${HOST}/api/video?text=${encodeURIComponent(text)}&qn=80`);
                    const response = await workerDefault.fetch(request, {}, ctxNoop);
                    const body = await response.json();

                    expect(response.status).toBe(200);
                    expect(body).toEqual({ status: 'error', message: '无效的 BV 号' });
                    expect(fetchFn.mock.calls.length).toBe(0);
                },
            ),
            { numRuns: 60 },
        );
    });
});

// ---------------------------------------------------------------------------
// 4. ERROR_MAP business codes — view returns a non-zero, non-(-352) code.
// ---------------------------------------------------------------------------
describe('Preservation 4: ERROR_MAP business codes (non -352)', () => {
    const knownCodeArb = fc
        .constantFrom(...KNOWN_CODES)
        .map((code) => ({ code, message: '上游原始消息', expected: ERROR_MAP[String(code)] }));

    const unknownCodeArb = fc
        .record({
            code: fc
                .integer({ min: -100_000, max: 100_000 })
                .filter((c) => c !== 0 && c !== -352 && !KNOWN_CODES.includes(c)),
            message: fc.string({ minLength: 1 }),
        })
        .map(({ code, message }) => ({ code, message, expected: message }));

    it('resolveVideo throws the mapped message and /api/video surfaces it', async () => {
        await fc.assert(
            fc.asyncProperty(fc.oneof(knownCodeArb, unknownCodeArb), async ({ code, message, expected }) => {
                globalThis.__cacheMock._clear();

                const routes = {
                    [ENDPOINTS.FINGER_SPI]: () => makeResponse({ data: { b_3: 'BUVID3', b_4: 'BUVID4' } }),
                    [ENDPOINTS.NAV]: () => makeResponse({ data: { wbi_img: { img_url: IMG_URL, sub_url: SUB_URL } } }),
                    [ENDPOINTS.PLAYURL]: () => makeResponse({ code: 0, data: { quality: 80, durl: [{ url: 'https://x.bilivideo.com/v.mp4' }] } }),
                    [ENDPOINTS.VIEW]: () => makeResponse({ code, message }),
                };

                // Direct call: resolveVideo throws with the mapped/fallback message.
                installFetchMock(routes);
                await expect(resolveVideo(BVID, 80, HOST)).rejects.toThrow(expected);

                // Wrapper: /api/video returns status 'error' with the same message.
                installFetchMock(routes);
                const request = new Request(`${HOST}/api/video?text=${encodeURIComponent(BVID)}&qn=80`);
                const response = await workerDefault.fetch(request, {}, ctxNoop);
                const body = await response.json();

                expect(response.status).toBe(200);
                expect(body).toEqual({ status: 'error', message: expected });
            }),
            { numRuns: 60 },
        );
    });
});

// ---------------------------------------------------------------------------
// 5. Cache hit — second /api/video call is served from caches.default.
// ---------------------------------------------------------------------------
describe('Preservation 5: cache hit returns cached success without re-fetching', () => {
    it('second identical /api/video call hits cache; fetch not called again', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    title: fc.string(),
                    pic: fc.string(),
                    author: fc.string(),
                    cid: fc.integer({ min: 1, max: 2_000_000_000 }),
                    quality: fc.constantFrom(32, 64, 80, 116),
                    durlUrl: fc.webUrl(),
                }),
                async ({ title, pic, author, cid, quality, durlUrl }) => {
                    globalThis.__cacheMock._clear();

                    const fetchFn = installFetchMock({
                        [ENDPOINTS.FINGER_SPI]: () => makeResponse({ data: { b_3: 'BUVID3', b_4: 'BUVID4' } }),
                        [ENDPOINTS.NAV]: () => makeResponse({ data: { wbi_img: { img_url: IMG_URL, sub_url: SUB_URL } } }),
                        [ENDPOINTS.VIEW]: () => makeResponse({ code: 0, data: { cid, title, pic, owner: { name: author } } }),
                        [ENDPOINTS.PLAYURL]: () => makeResponse({ code: 0, data: { quality, durl: [{ url: durlUrl }] } }),
                    });

                    const promises = [];
                    const ctx = { waitUntil: (p) => promises.push(p) };
                    const reqUrl = `${HOST}/api/video?text=${encodeURIComponent(BVID)}&qn=80`;

                    const res1 = await workerDefault.fetch(new Request(reqUrl), {}, ctx);
                    const body1 = await res1.json();
                    await Promise.all(promises); // ensure cache.put completed

                    expect(body1.status).toBe('success');
                    const callsAfterFirst = fetchFn.mock.calls.length;
                    expect(callsAfterFirst).toBeGreaterThan(0);

                    const res2 = await workerDefault.fetch(new Request(reqUrl), {}, ctx);
                    const body2 = await res2.json();

                    // No additional network calls — served from cache.
                    expect(fetchFn.mock.calls.length).toBe(callsAfterFirst);
                    expect(body2).toEqual(body1);
                },
            ),
            { numRuns: 40 },
        );
    });
});

// ---------------------------------------------------------------------------
// 6. /proxy — whitelist, Range pass-through, m3u8 rewrite.
// ---------------------------------------------------------------------------
describe('Preservation 6a: /proxy domain whitelist rejects non-allowed hosts', () => {
    it('returns 403 Forbidden and never fetches for non-whitelisted domains', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom('evil.com', 'example.org', 'malicious.net', 'google.com', 'youtube.com'),
                fc.string({ minLength: 1, maxLength: 10 }).map((s) => s.replace(/[^a-z0-9]/gi, 'a') || 'a'),
                async (domain, seg) => {
                    const fetchFn = installFetchMock({}); // any call throws
                    const target = `https://${domain}/${seg}.mp4`;
                    const request = new Request(`${HOST}/proxy?url=${encodeURIComponent(target)}`);
                    const response = await workerDefault.fetch(request, {}, ctxNoop);

                    expect(response.status).toBe(403);
                    expect(await response.text()).toBe('Forbidden');
                    expect(fetchFn.mock.calls.length).toBe(0);
                },
            ),
            { numRuns: 40 },
        );
    });
});

describe('Preservation 6b: /proxy allows whitelisted hosts, passes Range, copies Content-Type', () => {
    it('forwards Range header upstream and returns upstream status/Content-Type', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom('cn-gotcha.bilivideo.com', 'i0.hdslb.com', 'x.akamaized.net'),
                fc.constantFrom('video/mp4', 'application/octet-stream', 'video/x-flv'),
                fc.record({ start: fc.integer({ min: 0, max: 1000 }), len: fc.integer({ min: 1, max: 5000 }) }),
                async (host, contentType, { start, len }) => {
                    const range = `bytes=${start}-${start + len}`;
                    let capturedRange = 'NOT_SET';
                    const handler = (url, init) => {
                        capturedRange = init && init.headers && init.headers.get ? init.headers.get('Range') : null;
                        return makeResponse('VIDEODATA', { status: 200, contentType });
                    };
                    installFetchMock({ bilivideo: handler, hdslb: handler, akamaized: handler });

                    const target = `https://${host}/media/clip.mp4`;
                    const request = new Request(`${HOST}/proxy?url=${encodeURIComponent(target)}`, {
                        headers: { Range: range },
                    });
                    const response = await workerDefault.fetch(request, {}, ctxNoop);

                    expect(response.status).toBe(200);
                    expect(response.headers.get('Content-Type')).toBe(contentType);
                    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
                    expect(capturedRange).toBe(range);
                    expect(await response.text()).toBe('VIDEODATA');
                },
            ),
            { numRuns: 40 },
        );
    });
});

describe('Preservation 6c: /proxy m3u8 rewrite', () => {
    it('rewrites relative + absolute segment URLs through /proxy and sets HLS Content-Type', async () => {
        const target = 'https://cn-x.bilivideo.com/live/index.m3u8';
        const baseUrl = target.substring(0, target.lastIndexOf('/') + 1); // https://cn-x.bilivideo.com/live/
        const absoluteSeg = 'https://cn-x.bilivideo.com/live/seg1.ts';
        const m3u8Body = ['#EXTM3U', '#EXT-X-VERSION:3', 'seg0.ts', absoluteSeg].join('\n');

        installFetchMock({
            bilivideo: () => makeResponse(m3u8Body, { status: 200, contentType: 'application/vnd.apple.mpegurl' }),
        });

        const request = new Request(`${HOST}/proxy?url=${encodeURIComponent(target)}`);
        const response = await workerDefault.fetch(request, {}, ctxNoop);
        const text = await response.text();

        const expected = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            `${HOST}/proxy?url=${encodeURIComponent(baseUrl + 'seg0.ts')}`,
            `${HOST}/proxy?url=${encodeURIComponent(absoluteSeg)}`,
        ].join('\n');

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
        expect(text).toBe(expected);
    });

    it('returns 400 Missing URL when url param is absent', async () => {
        installFetchMock({});
        const request = new Request(`${HOST}/proxy`);
        const response = await workerDefault.fetch(request, {}, ctxNoop);
        expect(response.status).toBe(400);
        expect(await response.text()).toBe('Missing URL');
    });
});
