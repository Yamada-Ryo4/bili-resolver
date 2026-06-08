/**
 * Task 5 — Anti-Crawl Cookie Injection Property Test (Property 3)
 *
 * POST-FIX VERIFICATION. This file validates the NEW behavior introduced by the
 * fix (task 4): resolveVideo collects the anti-crawl Cookie exactly once via
 * getAntiCrawlCookie() (finger/spi + optional GenWebTicket) and injects that
 * Cookie header into all three video-resolve requests — view, nav and playurl.
 *
 * Property 3: Anti-Crawl Cookie — 视频请求附带反爬 Cookie 且单次采集.
 *   For any anti-crawl Cookie field combination (only buvid3 / +buvid4 /
 *   +bili_ticket, including the bili_ticket-failure degrade scenario), every one
 *   of the view / nav / playurl requests SHALL carry a Cookie header that always
 *   contains the collected buvid3, and within a single resolveVideo call the
 *   finger/spi endpoint SHALL be requested exactly once (Cookie collected once).
 *
 * Validates: Requirements 2.4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveVideo } from '../index.js';

const HOST = 'https://worker.test';
const BVID = 'BVxxxxxxxxxx'; // matches /BV[a-zA-Z0-9]{10}/

// Realistic Bilibili wbi_img basenames: two 32-char hex strings whose
// concatenation is 64 chars, satisfying getMixinKey's index table (max 63).
const IMG_URL = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB_URL = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';

// Routing keyword for the bili_ticket endpoint (see test/setup.js for the rest).
const GEN_WEB_TICKET = 'GenWebTicket';

/**
 * Read the Cookie header out of a fetch init object. The video-resolve path
 * passes plain-object headers (`{ 'Cookie': ... }`), but proxy code uses a
 * Headers instance — handle both so the assertion is robust.
 */
function getCookieHeader(init) {
    const h = init && init.headers;
    if (!h) return null;
    if (typeof h.get === 'function') return h.get('Cookie');
    return h['Cookie'] ?? h['cookie'] ?? null;
}

/** Parse a "k=v; k2=v2" Cookie header into a plain object. */
function parseCookie(cookie) {
    const out = {};
    if (!cookie) return out;
    for (const seg of cookie.split(';')) {
        const idx = seg.indexOf('=');
        if (idx === -1) continue;
        out[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
    }
    return out;
}

/**
 * Build the keyword-routed fetch mock for one resolveVideo run.
 *
 * @param {object} cfg
 * @param {string} cfg.buvid3          - b_3 value finger/spi returns (always present).
 * @param {string|null} cfg.buvid4     - b_4 value, or null to omit it.
 * @param {'ok'|'throw'|'nonOk'|'missing'} cfg.ticketScenario - GenWebTicket outcome.
 * @param {string} cfg.ticketVal       - ticket value used when scenario === 'ok'.
 * @param {object} captured            - mutated with the Cookie seen per endpoint.
 * @returns {Record<string, Function>} routes for installFetchMock.
 */
function buildRoutes({ buvid3, buvid4, ticketScenario, ticketVal }, captured) {
    return {
        [ENDPOINTS.FINGER_SPI]: () => {
            const data = { b_3: buvid3 };
            if (buvid4 !== null) data.b_4 = buvid4;
            return makeResponse({ code: 0, data });
        },
        [GEN_WEB_TICKET]: () => {
            if (ticketScenario === 'throw') throw new Error('GenWebTicket network down');
            if (ticketScenario === 'nonOk') return nonOkResponse(412);
            if (ticketScenario === 'missing') return makeResponse({ code: 0, data: {} });
            return makeResponse({ code: 0, data: { ticket: ticketVal } });
        },
        [ENDPOINTS.NAV]: (url, init) => {
            captured.nav = getCookieHeader(init);
            return makeResponse({ data: { wbi_img: { img_url: IMG_URL, sub_url: SUB_URL } } });
        },
        [ENDPOINTS.VIEW]: (url, init) => {
            captured.view = getCookieHeader(init);
            return makeResponse({
                code: 0,
                data: { cid: 1234567, title: '测试视频', pic: 'https://i0.hdslb.com/cover.jpg', owner: { name: 'UP主' } },
            });
        },
        [ENDPOINTS.PLAYURL]: (url, init) => {
            captured.playurl = getCookieHeader(init);
            return makeResponse({ code: 0, data: { quality: 80, durl: [{ url: 'https://cn-test.bilivideo.com/v.mp4' }] } });
        },
    };
}

// Clean, distinguishable identifier values (hex only -> no ';' / '=' to break
// Cookie parsing) so we can assert the collected buvid3 matches finger/spi.
const idArb = fc.hexaString({ minLength: 4, maxLength: 24 }).map((s) => s || 'deadbeef');

describe('Property 3: anti-crawl Cookie is injected into view/nav/playurl and collected once', () => {
    it('every request carries buvid3 and finger/spi is called exactly once across field combos', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    buvid3: idArb,
                    buvid4: fc.option(idArb, { nil: null }),
                    ticketScenario: fc.constantFrom('ok', 'throw', 'nonOk', 'missing'),
                    ticketVal: idArb,
                }),
                async (cfg) => {
                    // Fresh cache + capture slate per iteration (beforeEach only runs once per `it`).
                    globalThis.__cacheMock._clear();
                    const captured = { nav: undefined, view: undefined, playurl: undefined };

                    const fetchFn = installFetchMock(buildRoutes(cfg, captured));

                    await resolveVideo(BVID, 80, HOST);

                    // --- Assertion 1: every request received a Cookie containing the collected buvid3. ---
                    for (const ep of ['view', 'nav', 'playurl']) {
                        const cookie = captured[ep];
                        expect(cookie, `[${ep}] no Cookie header captured`).toBeTruthy();
                        expect(cookie, `[${ep}] Cookie missing buvid3=: ${cookie}`).toContain('buvid3=');

                        const parsed = parseCookie(cookie);
                        // finger/spi always returned a real b_3, so it (not the fallback) is used.
                        expect(parsed.buvid3, `[${ep}] buvid3 mismatch`).toBe(cfg.buvid3);

                        // When available, buvid4 / bili_ticket should be injected too.
                        if (cfg.buvid4 !== null) {
                            expect(parsed.buvid4, `[${ep}] buvid4 mismatch`).toBe(cfg.buvid4);
                        } else {
                            expect(cookie, `[${ep}] unexpected buvid4`).not.toContain('buvid4=');
                        }
                        if (cfg.ticketScenario === 'ok') {
                            expect(parsed.bili_ticket, `[${ep}] bili_ticket mismatch`).toBe(cfg.ticketVal);
                        } else {
                            expect(cookie, `[${ep}] unexpected bili_ticket`).not.toContain('bili_ticket=');
                        }
                    }

                    // The same Cookie string must be shared across all three requests (single collection).
                    expect(captured.nav).toBe(captured.view);
                    expect(captured.playurl).toBe(captured.view);

                    // --- Assertion 2: finger/spi is requested exactly once per resolveVideo call. ---
                    const fingerCalls = fetchFn.mock.calls.filter(([input]) => {
                        const url = typeof input === 'string' ? input : input && input.url;
                        return url && url.includes('finger/spi');
                    });
                    expect(fingerCalls.length, 'finger/spi must be called exactly once').toBe(1);

                    // Reinforcement (design): nav is cached -> requested exactly once too.
                    const navCalls = fetchFn.mock.calls.filter(([input]) => {
                        const url = typeof input === 'string' ? input : input && input.url;
                        return url && url.includes(ENDPOINTS.NAV);
                    });
                    expect(navCalls.length, 'nav must be called exactly once').toBe(1);
                },
            ),
            { numRuns: 50 },
        );
    });
});

describe('Property 3 — representative examples', () => {
    it('injects buvid3+buvid4+bili_ticket into all three requests on the full success path', async () => {
        globalThis.__cacheMock._clear();
        const captured = {};
        installFetchMock(
            buildRoutes({ buvid3: 'B3FULL', buvid4: 'B4FULL', ticketScenario: 'ok', ticketVal: 'TKFULL' }, captured),
        );

        await resolveVideo(BVID, 80, HOST);

        for (const ep of ['view', 'nav', 'playurl']) {
            const parsed = parseCookie(captured[ep]);
            expect(parsed.buvid3).toBe('B3FULL');
            expect(parsed.buvid4).toBe('B4FULL');
            expect(parsed.bili_ticket).toBe('TKFULL');
        }
    });

    it('degrades to buvid3-only Cookie on all three requests when GenWebTicket fails', async () => {
        globalThis.__cacheMock._clear();
        const captured = {};
        installFetchMock(
            buildRoutes({ buvid3: 'B3ONLY', buvid4: null, ticketScenario: 'throw', ticketVal: 'unused' }, captured),
        );

        await resolveVideo(BVID, 80, HOST);

        for (const ep of ['view', 'nav', 'playurl']) {
            const cookie = captured[ep];
            expect(parseCookie(cookie).buvid3).toBe('B3ONLY');
            expect(cookie).not.toContain('buvid4=');
            expect(cookie).not.toContain('bili_ticket=');
        }
    });
});
