/**
 * Smoke test for task 1: verifies the test runner boots and the named exports
 * added to index.js are wired correctly. This asserts wiring only — no behavior
 * is exercised here.
 */

import { describe, it, expect } from 'vitest';
import workerDefault, {
    resolveVideo,
    getPlayUrlWithFallback,
    signWbi,
    getBuvid,
} from '../index.js';

describe('test harness wiring', () => {
    it('exposes the named exports as functions', () => {
        expect(typeof resolveVideo).toBe('function');
        expect(typeof getPlayUrlWithFallback).toBe('function');
        expect(typeof signWbi).toBe('function');
        expect(typeof getBuvid).toBe('function');
    });

    it('keeps the default Worker export with a fetch handler', () => {
        expect(workerDefault).toBeTruthy();
        expect(typeof workerDefault.fetch).toBe('function');
    });

    it('provides the MD5 crypto.subtle shim', async () => {
        const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode('abc'));
        const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
        expect(hex).toBe('900150983cd24fb0d6963f7d28e17f72');
    });

    it('provides a Map-backed caches.default mock', async () => {
        const req = new Request('https://example.com/x');
        const res = new Response('cached');
        await caches.default.put(req, res);
        const hit = await caches.default.match(req);
        expect(hit).toBeTruthy();
        expect(await hit.text()).toBe('cached');
    });
});
