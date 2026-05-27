import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RegistryError,
  getSkillDetail,
  listVersions,
  registryFetch,
  resolveDownload,
  searchSkills,
} from './registry-client.js';

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ defaultTarget: 'project' as const })),
}));

const BASE = 'http://localhost:3001';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('registry-client', () => {
  const originalAsrUrl = process.env.ASR_URL;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.ASR_URL = BASE;
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    if (originalAsrUrl === undefined) {
      delete process.env.ASR_URL;
    } else {
      process.env.ASR_URL = originalAsrUrl;
    }
    vi.unstubAllGlobals();
  });

  describe('searchSkills', () => {
    it('issues a GET to /api/v1/skills?q=foo and returns parsed items', async () => {
      const items = [
        {
          owner: 'acme',
          name: 'code-review',
          latestVersion: '1.0.0',
          description: 'Reviews code',
          tags: ['security'],
          kind: 'skill',
          publishedAt: '2026-05-23T10:00:00Z',
          downloadCount: 42,
          riskAssessmentLatest: 'low',
        },
      ];
      fetchSpy.mockResolvedValueOnce(jsonResponse({ items, nextCursor: 'cur1' }));

      const result = await searchSkills('foo');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE}/api/v1/skills?q=foo`);
      expect((init as RequestInit).headers).toMatchObject({ Accept: 'application/json' });
      expect(result.items).toEqual(items);
      expect(result.nextCursor).toBe('cur1');
    });

    it('appends optional filters and pagination params', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }));

      await searchSkills('foo', {
        tag: ['security', 'review'],
        kind: 'skill',
        limit: 10,
        cursor: 'abc',
      });

      const [url] = fetchSpy.mock.calls[0];
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/v1/skills');
      expect(parsed.searchParams.get('q')).toBe('foo');
      expect(parsed.searchParams.getAll('tag')).toEqual(['security', 'review']);
      expect(parsed.searchParams.get('kind')).toBe('skill');
      expect(parsed.searchParams.get('limit')).toBe('10');
      expect(parsed.searchParams.get('cursor')).toBe('abc');
    });

    it('attaches Bearer authorization only when token is supplied', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }));

      await searchSkills('foo', {}, { token: 't0k' });

      const [, init] = fetchSpy.mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer t0k',
        Accept: 'application/json',
      });
    });
  });

  describe('getSkillDetail', () => {
    it('issues a GET to /api/v1/skills/:owner/:name', async () => {
      const detail = {
        owner: 'acme',
        name: 'code-review',
        latestVersion: '1.0.0',
        description: 'Reviews code',
        tags: [],
        kind: 'skill',
        publishedAt: '2026-05-23T10:00:00Z',
        downloadCount: 0,
        riskAssessmentLatest: 'low',
        manifestLatest: {},
        versions: [],
      };
      fetchSpy.mockResolvedValueOnce(jsonResponse(detail));

      const result = await getSkillDetail('acme', 'code-review');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE}/api/v1/skills/acme/code-review`);
      expect(result).toEqual(detail);
    });

    it('rejects with RegistryError carrying status on 404', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('skill not found', { status: 404 }));

      await expect(getSkillDetail('acme', 'missing')).rejects.toMatchObject({
        name: 'RegistryError',
        status: 404,
      });
    });

    it('encodes owner and name path segments', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      await getSkillDetail('acme/team', 'code review');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE}/api/v1/skills/acme%2Fteam/code%20review`);
    });
  });

  describe('listVersions', () => {
    it('issues a GET to /api/v1/skills/:owner/:name/versions', async () => {
      const versions = [
        {
          owner: 'acme',
          name: 'code-review',
          version: '1.0.0',
          contentHash: 'sha256:abc',
          publishedAt: '2026-05-23T10:00:00Z',
          publishedBy: 'user',
          approvedBy: null,
          prNumber: 1,
          mergeCommit: 'deadbeef',
          yanked: false,
          riskAssessment: 'low',
        },
      ];
      fetchSpy.mockResolvedValueOnce(jsonResponse(versions));

      const result = await listVersions('acme', 'code-review');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE}/api/v1/skills/acme/code-review/versions`);
      expect(result).toEqual(versions);
    });
  });

  describe('resolveDownload', () => {
    it('returns Location and yanked=true from a 302 with X-ASR-Yanked', async () => {
      const downloadUrl =
        'https://forgejo.internal/api/packages/acme/generic/code-review/1.0.0/skill.zip';
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: downloadUrl, 'X-ASR-Yanked': 'true' },
        })
      );

      const result = await resolveDownload('acme', 'code-review', '1.0.0');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE}/api/v1/skills/acme/code-review/v/1.0.0/download`);
      expect((init as RequestInit).redirect).toBe('manual');
      expect(result).toEqual({ url: downloadUrl, yanked: true });
    });

    it('returns yanked=false when X-ASR-Yanked header is absent', async () => {
      const downloadUrl =
        'https://forgejo.internal/api/packages/acme/generic/code-review/1.0.0/skill.zip';
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: downloadUrl },
        })
      );

      const result = await resolveDownload('acme', 'code-review', '1.0.0');
      expect(result).toEqual({ url: downloadUrl, yanked: false });
    });

    it('throws RegistryError if the 3xx response lacks a Location header', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 302 }));

      await expect(resolveDownload('acme', 'code-review', '1.0.0')).rejects.toMatchObject({
        name: 'RegistryError',
        status: 302,
      });
    });

    it('throws RegistryError on a non-3xx status', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));

      await expect(resolveDownload('acme', 'code-review', '1.0.0')).rejects.toMatchObject({
        name: 'RegistryError',
        status: 404,
      });
    });

    it('encodes owner, name, and version path segments and attaches Bearer token', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://x/y' } })
      );

      await resolveDownload('acme/team', 'code review', '1.0.0+build.1', { token: 't0k' });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        `${BASE}/api/v1/skills/acme%2Fteam/code%20review/v/1.0.0%2Bbuild.1/download`
      );
      expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer t0k' });
    });
  });

  describe('registryFetch', () => {
    it('throws RegistryError with status and body on non-2xx', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));

      try {
        await registryFetch('/api/v1/skills');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        expect((err as RegistryError).status).toBe(500);
        expect((err as RegistryError).body).toBe('boom');
      }
    });

    it('strips a trailing slash from the base URL', async () => {
      process.env.ASR_URL = `${BASE}/`;
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      await registryFetch('/api/v1/skills');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE}/api/v1/skills`);
    });
  });
});
