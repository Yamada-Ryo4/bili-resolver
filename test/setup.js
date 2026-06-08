/**
 * Vitest global setup for the Bilibili Resolver Worker tests.
 *
 * Injects the runtime globals the Cloudflare Worker expects but that Node's
 * test environment does not provide out of the box:
 *   - crypto.subtle.digest('MD5', ...)  -> Node WebCrypto has no MD5, shim via node:crypto
 *   - caches.default                    -> Map-backed match / put mock
 *   - fetch mock helpers                -> keyword-routed deterministic Responses
 *
 * HMAC-SHA256 (used by bili_ticket) is left to the native WebCrypto implementation.
 */

import { beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 1. crypto.subtle.digest('MD5', ...) shim
//    Node's WebCrypto refuses MD5. We patch the SubtleCrypto prototype so that
//    an 'MD5' request is served by node:crypto's createHash('md5'); every other
//    algorithm (e.g. HMAC-SHA256, SHA-256) falls through to the native impl.
// ---------------------------------------------------------------------------
(() => {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
        throw new Error('WebCrypto (crypto.subtle) is not available in this Node runtime.');
    }
    const subtleProto = Object.getPrototypeOf(globalThis.crypto.subtle);
    if (subtleProto.__md5Patched) return;
    const originalDigest = subtleProto.digest;
    subtleProto.digest = function digest(algorithm, data) {
        const name = typeof algorithm === 'string' ? algorithm : algorithm && algorithm.name;
        if (name && String(name).toUpperCase() === 'MD5') {
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(ArrayBuffer.isView(data) ? data.buffer : data);
            const hash = createHash('md5').update(Buffer.from(bytes)).digest();
            const out = hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
            return Promise.resolve(out);
        }
        return originalDigest.call(this, algorithm, data);
    };
    subtleProto.__md5Patched = true;
})();

// ---------------------------------------------------------------------------
// 2. caches.default mock (Map-backed match / put, keyed by request URL)
// ---------------------------------------------------------------------------
function createCacheMock() {
    const store = new Map();
    return {
        async match(request) {
            const key = typeof request === 'string' ? request : request.url;
            return store.get(key);
        },
        async put(request, response) {
            const key = typeof request === 'string' ? request : request.url;
            store.set(key, response);
        },
        _store: store,
        _clear() {
            store.clear();
        },
    };
}

const cacheMock = createCacheMock();
globalThis.caches = { default: cacheMock };

// Expose so tests can reset / inspect the cache.
globalThis.__cacheMock = cacheMock;

// ---------------------------------------------------------------------------
// 3. fetch mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a Response with an explicit status and Content-Type.
 * @param {*} body - object (JSON.stringified) or raw string body.
 * @param {{status?: number, contentType?: string}} [opts]
 * @returns {Response}
 */
export function makeResponse(body, opts = {}) {
    const { status = 200, contentType = 'application/json' } = opts;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': contentType } });
}

/** A typical Bilibili anti-crawl HTML risk-control page (text/html, status 200). */
export function htmlAntiCrawlResponse(status = 200) {
    return makeResponse('<!DOCTYPE html><html><head><title>403</title></head><body>blocked</body></html>', {
        status,
        contentType: 'text/html',
    });
}

/** A response that claims to be JSON but whose body is HTML (starts with '<'). */
export function htmlBodyAsJsonResponse(status = 200) {
    return makeResponse('<!DOCTYPE html><html></html>', { status, contentType: 'application/json' });
}

/** A Bilibili risk-control JSON payload (code:-352). */
export function code352Response() {
    return makeResponse({ code: -352, message: '风控校验失败', data: { v_voucher: 'voucher_test' } });
}

/** A non-2xx response with an (optionally HTML) body. */
export function nonOkResponse(status = 412, body = '<!DOCTYPE html><html></html>') {
    return makeResponse(body, { status, contentType: 'text/html' });
}

/**
 * Well-known Bilibili endpoint keyword fragments used for routing.
 */
export const ENDPOINTS = {
    FINGER_SPI: 'finger/spi',
    NAV: 'web-interface/nav',
    PLAYURL: 'player/wbi/playurl',
    VIEW: 'web-interface/view',
};

/**
 * Install a keyword-routed fetch mock.
 *
 * @param {Record<string, Response|((url:string, init:any)=>Response|Promise<Response>)>} routes
 *   Map of URL keyword fragment -> Response (or handler returning one).
 *   The first key whose fragment is contained in the request URL wins.
 * @returns {import('vitest').Mock} the underlying vi.fn for call assertions.
 */
export function installFetchMock(routes) {
    const fn = vi.fn(async (input, init) => {
        const url = typeof input === 'string' ? input : input && input.url;
        for (const [keyword, handler] of Object.entries(routes)) {
            if (url && url.includes(keyword)) {
                const result = typeof handler === 'function' ? await handler(url, init) : handler;
                // Clone so repeated routing of the same Response object stays consumable.
                return result instanceof Response ? result.clone() : result;
            }
        }
        throw new Error(`installFetchMock: no route matched URL: ${url}`);
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

// Also expose helpers on globalThis for tests that prefer not to import.
globalThis.makeResponse = makeResponse;
globalThis.htmlAntiCrawlResponse = htmlAntiCrawlResponse;
globalThis.htmlBodyAsJsonResponse = htmlBodyAsJsonResponse;
globalThis.code352Response = code352Response;
globalThis.nonOkResponse = nonOkResponse;
globalThis.installFetchMock = installFetchMock;
globalThis.ENDPOINTS = ENDPOINTS;

// ---------------------------------------------------------------------------
// 4. Per-test cleanup: reset cache + restore any stubbed globals (fetch).
// ---------------------------------------------------------------------------
beforeEach(() => {
    cacheMock._clear();
    vi.unstubAllGlobals();
});
