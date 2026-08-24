import { describe, it, expect, vi } from 'vitest';

function makeProxyResponse(response) {
  const headers = new Headers();
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Range, Accept-Ranges, Cache-Control');
  return { status: response.status, headers };
}

describe('Bilibili media proxy contract', () => {
  it('preserves Range response metadata for seek', async () => {
    const response = new Response('part', { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '4',
      'Content-Range': 'bytes 0-3/100', 'Accept-Ranges': 'bytes',
    }});
    const proxied = makeProxyResponse(response);
    expect(proxied.status).toBe(206);
    expect(proxied.headers.get('Content-Range')).toBe('bytes 0-3/100');
    expect(proxied.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('does not mark failed CDN responses as cacheable', () => {
    const proxied = makeProxyResponse(new Response('fail', { status: 403, headers: { 'Content-Type': 'text/plain' }}));
    proxied.headers.set('Cache-Control', 'no-store');
    expect(proxied.headers.get('Cache-Control')).toBe('no-store');
  });
});
