import { describe, it, expect } from 'vitest';
import workerDefault from '../index.js';

describe('Bilibili quality and seek UI contract', () => {
  it('serves a UI with 1080p/720p options and seek prefetch markers', async () => {
    const response = await workerDefault.fetch(new Request('https://bili.example/'), {});
    const html = await response.text();
    expect(html).toContain('value="116"');
    expect(html).toContain('value="80"');
    expect(html).toContain('value="64"');
    expect(html).toContain('startLevel');
    expect(html).toContain('maxBufferLength: 45');
    expect(html).toContain('maxMaxBufferLength: 90');
    expect(html).toContain('backBufferLength: 60');
    expect(html).toContain('PREFETCH_WINDOW_SIZE');
    expect(html).toContain('AbortController');
    expect(html).toContain('LEVEL_LOADED');
    expect(html).toContain('Promise.allSettled');
    expect(html).toContain('seeking');
  });
});
