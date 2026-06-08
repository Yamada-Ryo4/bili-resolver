/**
 * Bug Condition / Anti-Crawl Property Test (Property 1)
 *
 * Property 1: 反爬响应不得泄漏英文 JSON 解析错误.
 *   For any video-resolve request where the upstream returns an anti-crawl
 *   response (HTML body, HTML-but-claims-JSON, code:-352, or non-2xx), the
 *   resolver MUST NOT surface a raw English JSON parse error ("Unexpected
 *   token" / "is not valid JSON"), and the /api/video wrapper MUST return
 *   { status: "error", message: <readable Chinese anti-crawl message> }.
 *
 * MULTI-LINE NOTE: video stream resolution now tries several independent
 * playurl lines (APP iOS / TV via `player/playurl`, and web wbi via
 * `player/wbi/playurl`). A single line being anti-crawled is NOT a failure —
 * the resolver falls through to the next line. Therefore, to assert the
 * "final anti-crawl error" behavior, the relevant endpoints must ALL be
 * anti-crawled:
 *   - view:    single choke point before any stream line.
 *   - playurl: ALL stream lines (web wbi + APP + TV) must be anti-crawled.
 *   - nav:     nav only affects the web line; with APP/TV also anti-crawled,
 *              the whole stream stage fails as anti-crawl.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import workerDefault, { resolveVideo } from '../index.js';

// Realistic Bilibili wbi_img basenames: two 32-char hex strings so that their
// concatenation is 64 chars long, satisfying getMixinKey's index table (max 63).
const IMG_URL = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB_URL = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';

const HOST = 'https://worker.test';
const BVID = 'BVxxxxxxxxxx'; // matches /BV[a-zA-Z0-9]{10}/

// Post-fix readable Chinese anti-crawl message (design: ANTI_CRAWL_MSG).
// Note "风控拦截" deliberately distinguishes the expected message from the raw
// upstream "风控校验失败" that the unfixed code leaks for code:-352.
const ANTI_CRAWL_HINT = '风控拦截';

// Routing keywords. APP/TV lines hit `player/playurl`; web line hits
// `player/wbi/playurl`. The web keyword is a substring of neither — we route
// the more specific `wbi/playurl` first in buildRoutes via key ordering.
const WBI_PLAYURL = 'player/wbi/playurl';
const APP_PLAYURL = 'player/playurl';
const NAV = 'web-interface/nav';
const VIEW = 'web-interface/view';
const FINGER = 'finger/spi';

// --- Valid (happy-path) response factories for the non-targeted endpoints. ---
function validFingerSpi() {
    return makeResponse({ data: { b_3: 'BUVID3-TEST-VALUE', b_4: 'BUVID4-TEST-VALUE' } });
}
function validNav() {
    return makeResponse({ data: { wbi_img: { img_url: IMG_URL, sub_url: SUB_URL } } });
}
function validView() {
    return makeResponse({
        code: 0,
        data: { cid: 1234567, title: '测试视频标题', pic: 'https://i0.hdslb.com/cover.jpg', owner: { name: 'UP主' } },
    });
}
function validPlayurl() {
    return makeResponse({ code: 0, data: { quality: 80, durl: [{ url: 'https://cn-test.bilivideo.com/video.mp4' }] } });
}

// --- Anti-crawl response factories keyed by type. ---
const ANTI_CRAWL_FACTORIES = {
    html: () => htmlAntiCrawlResponse(), // text/html risk-control page
    htmlAsJson: () => htmlBodyAsJsonResponse(), // body starts with '<' but Content-Type application/json
    code352: () => code352Response(), // {code:-352} risk-control JSON
    nonOk: () => nonOkResponse(), // non-2xx (412) with HTML body
};

/**
 * Install a fetch mock where finger/spi returns a valid buvid and the selected
 * stage is anti-crawled across ALL of its endpoints, while the rest return
 * valid JSON.
 *
 * targetStage:
 *   - 'view'    -> the view endpoint is anti-crawled (single choke point).
 *   - 'playurl' -> ALL stream lines (web wbi + APP/TV player/playurl) are
 *                  anti-crawled; nav stays valid.
 *   - 'nav'     -> nav is anti-crawled AND APP/TV player/playurl are too, so the
 *                  whole stream stage fails as anti-crawl (web line is skipped
 *                  because nav is unavailable; APP/TV are anti-crawled).
 *
 * IMPORTANT: installFetchMock matches the FIRST keyword contained in the URL.
 * Because 'player/playurl' is a substring of 'player/wbi/playurl' is FALSE
 * (wbi sits between), we list WBI_PLAYURL before APP_PLAYURL to be explicit.
 */
function buildRoutes(targetStage, antiCrawlType) {
    const ac = ANTI_CRAWL_FACTORIES[antiCrawlType];
    const routes = {
        [FINGER]: validFingerSpi,
        [NAV]: validNav,
        [VIEW]: validView,
        [WBI_PLAYURL]: validPlayurl,
        [APP_PLAYURL]: validPlayurl,
    };
    if (targetStage === 'view') {
        routes[VIEW] = ac;
    } else if (targetStage === 'playurl') {
        routes[WBI_PLAYURL] = ac;
        routes[APP_PLAYURL] = ac;
    } else if (targetStage === 'nav') {
        routes[NAV] = ac;
        routes[WBI_PLAYURL] = ac;
        routes[APP_PLAYURL] = ac;
    }
    return routes;
}

function isEnglishJsonParseError(message) {
    if (!message) return false;
    return message.includes('Unexpected token') || message.includes('is not valid JSON');
}

describe('Property 1: anti-crawl response must not leak English JSON parse errors', () => {
    it('returns a readable Chinese anti-crawl error when a stage is fully anti-crawled', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom('nav', 'playurl', 'view'),
                fc.constantFrom('html', 'htmlAsJson', 'code352', 'nonOk'),
                async (targetStage, antiCrawlType) => {
                    const combo = `${targetStage} × ${antiCrawlType}`;

                    // Reset the Map-backed cache between iterations (beforeEach only
                    // runs once per `it`); error responses are never cached anyway.
                    globalThis.__cacheMock._clear();

                    // -------- 1) Direct resolveVideo call --------
                    installFetchMock(buildRoutes(targetStage, antiCrawlType));
                    let directError = null;
                    try {
                        await resolveVideo(BVID, 80, HOST);
                    } catch (e) {
                        directError = e;
                    }

                    // The caught error MUST NOT be a raw English JSON parse error.
                    expect(
                        isEnglishJsonParseError(directError && directError.message),
                        `[${combo}] resolveVideo leaked English JSON parse error: ${directError && directError.message}`,
                    ).toBe(false);

                    // -------- 2) /api/video wrapper call --------
                    installFetchMock(buildRoutes(targetStage, antiCrawlType));
                    const request = new Request(
                        `${HOST}/api/video?text=${encodeURIComponent(BVID)}&qn=80`,
                    );
                    const ctx = { waitUntil() {} };
                    const response = await workerDefault.fetch(request, {}, ctx);
                    const body = await response.json();

                    expect(body.status, `[${combo}] wrapper status`).toBe('error');
                    expect(
                        isEnglishJsonParseError(body.message),
                        `[${combo}] wrapper leaked English JSON parse error: ${body.message}`,
                    ).toBe(false);
                    expect(
                        typeof body.message === 'string' && body.message.includes(ANTI_CRAWL_HINT),
                        `[${combo}] wrapper message is not a readable Chinese anti-crawl message: ${body.message}`,
                    ).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });
});

describe('Property 1b: a single anti-crawled stream line falls through to a healthy line', () => {
    it('still resolves successfully when only the web wbi line is anti-crawled', async () => {
        globalThis.__cacheMock._clear();
        // web wbi playurl is anti-crawled, but APP/TV player/playurl is healthy.
        installFetchMock({
            [FINGER]: validFingerSpi,
            [NAV]: validNav,
            [VIEW]: validView,
            [WBI_PLAYURL]: () => htmlAntiCrawlResponse(),
            [APP_PLAYURL]: validPlayurl,
        });

        const result = await resolveVideo(BVID, 80, HOST);
        expect(result.isLive).toBe(false);
        expect(result.quality).toBe(80);
        expect(result.playableUrl).toContain('/proxy?url=');
    });

    it('still resolves when nav is anti-crawled but APP/TV line is healthy', async () => {
        globalThis.__cacheMock._clear();
        installFetchMock({
            [FINGER]: validFingerSpi,
            [NAV]: () => code352Response(),
            [VIEW]: validView,
            [WBI_PLAYURL]: validPlayurl, // unreachable: nav failed so web line is skipped
            [APP_PLAYURL]: validPlayurl,
        });

        const result = await resolveVideo(BVID, 80, HOST);
        expect(result.isLive).toBe(false);
        expect(result.playableUrl).toContain('/proxy?url=');
    });
});
