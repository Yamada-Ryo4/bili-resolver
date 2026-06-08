/**
 * Task 4.3 — Tests for the anti-crawl Cookie collector getAntiCrawlCookie().
 *
 * getAntiCrawlCookie() builds a Cookie header that lowers risk-control
 * probability for the video-resolve path:
 *   1) finger/spi -> buvid3 (b_3) / buvid4 (b_4); on failure it falls back to
 *      the same hardcoded buvid3 constant getBuvid() uses (buvid3 always present).
 *   2) optional bili_ticket via HMAC-SHA256 + GenWebTicket, wrapped in try/catch
 *      so ANY failure degrades gracefully to just buvid3/buvid4 without aborting.
 *   3) returns an assembled Cookie string, skipping missing parts.
 *
 * This also seeds the later Property 3 (anti-crawl Cookie) task with a
 * lightweight property: buvid3 is ALWAYS present in the returned Cookie.
 *
 * Validates: Requirements 2.4, 3.2
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getAntiCrawlCookie } from '../index.js';

// Mirrors the hardcoded fallback buvid3 in index.js (getBuvid / FALLBACK_BUVID3).
const FALLBACK_BUVID3 = 'FE6D3664-927F-F75B-B7D4-733E5D4B263F69428infoc';

const FINGER_SPI = 'finger/spi';
const GEN_WEB_TICKET = 'GenWebTicket';

/** Parse a "k=v; k2=v2" Cookie header into a plain object. */
function parseCookie(cookie) {
    const out = {};
    for (const seg of cookie.split(';')) {
        const idx = seg.indexOf('=');
        if (idx === -1) continue;
        out[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
    }
    return out;
}

describe('getAntiCrawlCookie — full success path', () => {
    it('includes buvid3, buvid4 and bili_ticket when both endpoints succeed', async () => {
        installFetchMock({
            [FINGER_SPI]: () => makeResponse({ code: 0, data: { b_3: 'B3VAL', b_4: 'B4VAL' } }),
            [GEN_WEB_TICKET]: () => makeResponse({ code: 0, data: { ticket: 'TICKETVAL' } }),
        });

        const cookie = await getAntiCrawlCookie();
        const parsed = parseCookie(cookie);

        expect(parsed.buvid3).toBe('B3VAL');
        expect(parsed.buvid4).toBe('B4VAL');
        expect(parsed.bili_ticket).toBe('TICKETVAL');
    });
});

describe('getAntiCrawlCookie — bili_ticket degradation', () => {
    it('omits bili_ticket but keeps buvid3/buvid4 when GenWebTicket throws', async () => {
        installFetchMock({
            [FINGER_SPI]: () => makeResponse({ code: 0, data: { b_3: 'B3VAL', b_4: 'B4VAL' } }),
            [GEN_WEB_TICKET]: () => {
                throw new Error('network down');
            },
        });

        const cookie = await getAntiCrawlCookie();
        const parsed = parseCookie(cookie);

        expect(parsed.buvid3).toBe('B3VAL');
        expect(parsed.buvid4).toBe('B4VAL');
        expect(cookie).not.toContain('bili_ticket');
    });

    it('omits bili_ticket when GenWebTicket returns a non-2xx response', async () => {
        installFetchMock({
            [FINGER_SPI]: () => makeResponse({ code: 0, data: { b_3: 'B3VAL' } }),
            [GEN_WEB_TICKET]: () => nonOkResponse(412),
        });

        const cookie = await getAntiCrawlCookie();
        const parsed = parseCookie(cookie);

        expect(parsed.buvid3).toBe('B3VAL');
        expect(cookie).not.toContain('bili_ticket');
    });

    it('omits bili_ticket when GenWebTicket JSON is missing data.ticket', async () => {
        installFetchMock({
            [FINGER_SPI]: () => makeResponse({ code: 0, data: { b_3: 'B3VAL' } }),
            [GEN_WEB_TICKET]: () => makeResponse({ code: 0, data: {} }),
        });

        const cookie = await getAntiCrawlCookie();
        expect(cookie).toContain('buvid3=B3VAL');
        expect(cookie).not.toContain('bili_ticket');
    });
});

describe('getAntiCrawlCookie — finger/spi failure falls back to hardcoded buvid3', () => {
    it('still contains the fallback buvid3 constant when finger/spi throws', async () => {
        installFetchMock({
            [FINGER_SPI]: () => {
                throw new Error('finger/spi unreachable');
            },
            [GEN_WEB_TICKET]: () => {
                throw new Error('ticket unreachable');
            },
        });

        const cookie = await getAntiCrawlCookie();

        expect(cookie.startsWith('buvid3=')).toBe(true);
        expect(cookie).toContain(`buvid3=${FALLBACK_BUVID3}`);
    });
});

describe('getAntiCrawlCookie — property: buvid3 is always present', () => {
    it('returns a Cookie containing buvid3 across randomized field availability', async () => {
        await fc.assert(
            fc.asyncProperty(
                // whether finger/spi succeeds, and which fields it returns
                fc.boolean(), // fingerOk
                fc.boolean(), // hasB4
                fc.boolean(), // ticketOk
                async (fingerOk, hasB4, ticketOk) => {
                    installFetchMock({
                        [FINGER_SPI]: () => {
                            if (!fingerOk) throw new Error('finger/spi failed');
                            const data = { b_3: 'B3RAND' };
                            if (hasB4) data.b_4 = 'B4RAND';
                            return makeResponse({ code: 0, data });
                        },
                        [GEN_WEB_TICKET]: () => {
                            if (!ticketOk) throw new Error('ticket failed');
                            return makeResponse({ code: 0, data: { ticket: 'TRAND' } });
                        },
                    });

                    const cookie = await getAntiCrawlCookie();
                    const parsed = parseCookie(cookie);

                    // buvid3 is ALWAYS present.
                    expect(parsed.buvid3, `cookie missing buvid3: ${cookie}`).toBeTruthy();
                    // finger/spi failure => fallback buvid3 constant.
                    if (!fingerOk) {
                        expect(parsed.buvid3).toBe(FALLBACK_BUVID3);
                    }
                    // buvid4 only when finger/spi succeeded and provided b_4.
                    if (fingerOk && hasB4) {
                        expect(parsed.buvid4).toBe('B4RAND');
                    } else {
                        expect(cookie).not.toContain('buvid4');
                    }
                    // bili_ticket only when GenWebTicket succeeded.
                    if (ticketOk) {
                        expect(parsed.bili_ticket).toBe('TRAND');
                    } else {
                        expect(cookie).not.toContain('bili_ticket');
                    }
                },
            ),
            { numRuns: 40 },
        );
    });
});
