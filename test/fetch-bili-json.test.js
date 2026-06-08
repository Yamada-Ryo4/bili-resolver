/**
 * Task 4.2 — Unit tests for the safe JSON fetch helper fetchBiliJson(url, options).
 *
 * fetchBiliJson centralizes anti-crawl detection at the source: status-code
 * check, Content-Type / body sniffing, JSON.parse guarding, and code:-352
 * recognition. On any anti-crawl signal it throws an AntiCrawlError (Chinese
 * message), and it NEVER lets a raw "Unexpected token" / "is not valid JSON"
 * error escape. Non -352 business codes (e.g. -404) are returned as-is so the
 * callers' existing ERROR_MAP logic still runs (Preservation).
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 3.4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fetchBiliJson, AntiCrawlError, ANTI_CRAWL_MSG } from '../index.js';

const URL = 'https://api.bilibili.com/x/web-interface/view?bvid=BVxxxxxxxxxx';

function isEnglishJsonParseError(message) {
    if (!message) return false;
    return message.includes('Unexpected token') || message.includes('is not valid JSON');
}

describe('fetchBiliJson — valid JSON is returned as-is', () => {
    it('returns the parsed object for a normal {code:0,...} payload', async () => {
        installFetchMock({
            [ENDPOINTS.VIEW]: () =>
                makeResponse({ code: 0, data: { cid: 123, title: 't' }, message: '0' }),
        });
        const json = await fetchBiliJson(URL, { headers: { 'User-Agent': 'x' } });
        expect(json).toEqual({ code: 0, data: { cid: 123, title: 't' }, message: '0' });
    });

    it('returns a -404 business-code object as-is (NOT intercepted)', async () => {
        installFetchMock({
            [ENDPOINTS.VIEW]: () => makeResponse({ code: -404, message: '啥都木有' }),
        });
        const json = await fetchBiliJson(URL);
        expect(json).toEqual({ code: -404, message: '啥都木有' });
    });

    it('does not intercept other non-zero, non -352 business codes', async () => {
        for (const code of [-400, -403, -10403, 62002, 62004]) {
            installFetchMock({
                [ENDPOINTS.VIEW]: () => makeResponse({ code, message: 'biz' }),
            });
            const json = await fetchBiliJson(URL);
            expect(json.code).toBe(code);
        }
    });
});

describe('fetchBiliJson — anti-crawl responses throw AntiCrawlError', () => {
    it('throws AntiCrawlError for an HTML risk-control page (text/html)', async () => {
        installFetchMock({ [ENDPOINTS.NAV]: () => htmlAntiCrawlResponse() });
        const navUrl = 'https://api.bilibili.com/x/web-interface/nav';
        let err = null;
        try {
            await fetchBiliJson(navUrl);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(AntiCrawlError);
        expect(err.name).toBe('AntiCrawlError');
        expect(err.message).toBe(ANTI_CRAWL_MSG);
        expect(isEnglishJsonParseError(err.message)).toBe(false);
    });

    it('throws AntiCrawlError when body starts with "<" but Content-Type is application/json', async () => {
        installFetchMock({ [ENDPOINTS.VIEW]: () => htmlBodyAsJsonResponse() });
        await expect(fetchBiliJson(URL)).rejects.toBeInstanceOf(AntiCrawlError);
    });

    it('throws AntiCrawlError for a non-2xx response (e.g. 412)', async () => {
        installFetchMock({ [ENDPOINTS.PLAYURL]: () => nonOkResponse(412) });
        const playUrl = 'https://api.bilibili.com/x/player/wbi/playurl?bvid=x';
        await expect(fetchBiliJson(playUrl)).rejects.toBeInstanceOf(AntiCrawlError);
    });

    it('throws AntiCrawlError for code:-352 risk-control JSON', async () => {
        installFetchMock({ [ENDPOINTS.VIEW]: () => code352Response() });
        let err = null;
        try {
            await fetchBiliJson(URL);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(AntiCrawlError);
        expect(err.message).toBe(ANTI_CRAWL_MSG);
    });

    it('throws AntiCrawlError (not a SyntaxError) for malformed JSON with application/json', async () => {
        installFetchMock({
            [ENDPOINTS.VIEW]: () => makeResponse('{not json', { status: 200, contentType: 'application/json' }),
        });
        let err = null;
        try {
            await fetchBiliJson(URL);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(AntiCrawlError);
        expect(isEnglishJsonParseError(err.message)).toBe(false);
    });
});

describe('fetchBiliJson — never leaks English JSON parse errors (property)', () => {
    const ANTI_CRAWL_FACTORIES = {
        html: () => htmlAntiCrawlResponse(),
        htmlAsJson: () => htmlBodyAsJsonResponse(),
        code352: () => code352Response(),
        nonOk: () => nonOkResponse(412),
    };

    it('throws AntiCrawlError with the Chinese message for every anti-crawl response type', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom('html', 'htmlAsJson', 'code352', 'nonOk'),
                async (type) => {
                    installFetchMock({ [ENDPOINTS.VIEW]: ANTI_CRAWL_FACTORIES[type] });
                    let err = null;
                    try {
                        await fetchBiliJson(URL);
                    } catch (e) {
                        err = e;
                    }
                    expect(err, `[${type}] expected a thrown error`).toBeInstanceOf(AntiCrawlError);
                    expect(err.message, `[${type}] message`).toBe(ANTI_CRAWL_MSG);
                    expect(
                        isEnglishJsonParseError(err.message),
                        `[${type}] leaked English JSON parse error: ${err.message}`,
                    ).toBe(false);
                },
            ),
            { numRuns: 40 },
        );
    });
});
