import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const skillDetail = {
  owner: 'asr',
  name: 'security-review',
  latestVersion: '1.0.0',
  description: 'Review code for security issues.',
  tags: ['security', 'review'],
  kind: 'skill',
  publishedAt: '2026-05-25T12:00:00.000Z',
  downloadCount: 42,
  riskAssessmentLatest: 'low',
  manifestLatest: {
    name: 'security-review',
    version: '1.0.0',
    author: 'Platform Team',
    description: 'Review code for security issues.',
    tags: ['security', 'review'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  },
  skillMd: `---
name: security-review
version: 1.0.0
author: Platform Team
description: Review code for security issues.
tags: [security, review]
---

# Secure Review

| Check | Evidence |
| --- | --- |
| Secrets | scanner output |
`,
  versions: [
    {
      owner: 'asr',
      name: 'security-review',
      version: '1.0.0',
      contentHash: 'sha256:abc',
      publishedAt: '2026-05-25T12:00:00.000Z',
      publishedBy: 'submitter',
      approvedBy: 'reviewer',
      prNumber: 12,
      mergeCommit: 'abc123',
      yanked: false,
      riskAssessment: 'low',
    },
  ],
};

const workflowSkill = {
  owner: 'asr',
  name: 'release-notes',
  latestVersion: '1.4.0',
  description: 'Generate release notes from approved changes.',
  tags: ['release', 'writing'],
  kind: 'workflow',
  publishedAt: '2026-05-25T13:00:00.000Z',
  downloadCount: 7,
  riskAssessmentLatest: 'high',
  manifestLatest: {
    name: 'release-notes',
    version: '1.4.0',
    author: 'Platform Team',
    description: 'Generate release notes from approved changes.',
    tags: ['release', 'writing'],
    kind: 'workflow',
  },
  skillMd: '# Release Notes\n',
  versions: [],
};

function createZipFile(filePaths: string[]): File {
  const encoder = new TextEncoder();
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let offset = 0;

  function writeUint16(view: DataView, byteOffset: number, value: number) {
    view.setUint16(byteOffset, value, true);
  }

  function writeUint32(view: DataView, byteOffset: number, value: number) {
    view.setUint32(byteOffset, value, true);
  }

  for (const path of filePaths) {
    const name = encoder.encode(path);
    const content = encoder.encode('content');
    const local = new Uint8Array(30 + name.length + content.length);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint32(localView, 18, content.length);
    writeUint32(localView, 22, content.length);
    writeUint16(localView, 26, name.length);
    local.set(name, 30);
    local.set(content, 30 + name.length);
    localRecords.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint32(centralView, 20, content.length);
    writeUint32(centralView, 24, content.length);
    writeUint16(centralView, 28, name.length);
    writeUint32(centralView, 42, offset);
    central.set(name, 46);
    centralRecords.push(central);
    offset += local.length;
  }

  const centralDirectorySize = centralRecords.reduce((total, record) => total + record.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeUint32(eocdView, 0, 0x06054b50);
  writeUint16(eocdView, 8, filePaths.length);
  writeUint16(eocdView, 10, filePaths.length);
  writeUint32(eocdView, 12, centralDirectorySize);
  writeUint32(eocdView, 16, offset);

  const parts = [...localRecords, ...centralRecords, eocd].map((record) => (
    record.buffer.slice(record.byteOffset, record.byteOffset + record.byteLength) as ArrayBuffer
  ));
  return new File(parts, 'skill.zip', { type: 'application/zip' });
}

function renderRoute(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  window.history.pushState({}, '', initialEntry);
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches,
    media: '(max-width: 640px)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = String(input);
    const body = url.endsWith('/api/v1/skills/asr/security-review')
      ? skillDetail
      : { items: [skillDetail, workflowSkill] };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));

  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
});

describe('router', () => {
  it('routes /review to the review queue with an empty state when the API returns no submissions', async () => {
    renderRoute('/review');

    expect(await screen.findByRole('heading', { name: /^review queue$/i })).toBeInTheDocument();
    expect(await screen.findByText(/no submissions awaiting review/i)).toBeInTheDocument();
  });

  it('renders the application shell (logo, primary nav, mock auth banner) on /review', async () => {
    renderRoute('/review');

    expect(await screen.findByRole('heading', { name: /^review queue$/i })).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /asr home/i })).toHaveAttribute('href', '/');

    const primaryNav = screen.getByRole('navigation', { name: /primary navigation/i });
    expect(within(primaryNav).getByRole('link', { name: /browse/i })).toHaveAttribute('href', '/');
    expect(within(primaryNav).getByRole('link', { name: /publish/i })).toHaveAttribute('href', '/publish');
    expect(within(primaryNav).getByRole('link', { name: /review/i })).toHaveAttribute('aria-current', 'page');

    expect(screen.getByRole('status', { name: /development mock auth session/i })).toBeInTheDocument();
    expect(screen.getByText(/dev mock auth/i)).toBeInTheDocument();
  });

  it('keeps the existing browse page on the index route', async () => {
    renderRoute('/');

    expect(await screen.findByRole('heading', { level: 1, name: /^asr$/i })).toBeInTheDocument();
  });

  it('shows kind and risk badges on browse skill cards', async () => {
    renderRoute('/');

    const card = await screen.findByRole('link', { name: /open asr\/security-review details/i });
    expect(within(card).getByText('skill')).toBeInTheDocument();
    expect(within(card).getByText(/low risk/i)).toBeInTheDocument();
  });

  it('filters browse cards by the search input client-side', async () => {
    renderRoute('/');

    expect(await screen.findByRole('link', { name: /open asr\/security-review details/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open asr\/release-notes details/i })).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText(/search agent skills/i);
    fireEvent.change(searchInput, { target: { value: 'xyzzzzzzzzzzzzzz-impossible' } });

    expect(screen.queryByRole('link', { name: /open asr\/security-review details/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open asr\/release-notes details/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no skills match your search/i)).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'security' } });
    expect(screen.getByRole('link', { name: /open asr\/security-review details/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open asr\/release-notes details/i })).not.toBeInTheDocument();
  });

  it('filters browse cards by kind and risk chips', async () => {
    renderRoute('/');

    expect(await screen.findByRole('link', { name: /open asr\/security-review details/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open asr\/release-notes details/i })).toBeInTheDocument();

    const kindFilters = screen.getByRole('group', { name: /filter skills by kind/i });
    fireEvent.click(within(kindFilters).getByRole('button', { name: /^workflow$/i }));
    expect(screen.queryByRole('link', { name: /open asr\/security-review details/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open asr\/release-notes details/i })).toBeInTheDocument();

    const riskFilters = screen.getByRole('group', { name: /filter skills by risk/i });
    fireEvent.click(within(riskFilters).getByRole('button', { name: /^low risk$/i }));
    expect(screen.queryByRole('link', { name: /open asr\/release-notes details/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no skills match your search/i)).toBeInTheDocument();

    fireEvent.click(within(riskFilters).getByRole('button', { name: /^all$/i }));
    expect(screen.getByRole('link', { name: /open asr\/release-notes details/i })).toBeInTheDocument();
  });

  it('opens primary navigation from the mobile drawer control', async () => {
    renderRoute('/');

    expect(await screen.findByRole('heading', { level: 1, name: /^asr$/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open primary navigation/i }));

    const mobileNav = screen.getByRole('complementary', { name: /mobile primary navigation/i });
    expect(mobileNav).toBeInTheDocument();
    expect(within(mobileNav).getByRole('link', { name: /browse/i })).toHaveAttribute('aria-current', 'page');
    expect(within(mobileNav).getByRole('link', { name: /publish/i })).toBeInTheDocument();
    expect(within(mobileNav).getByRole('link', { name: /review/i })).toBeInTheDocument();
  });

  it('renders browse loading as content skeletons instead of a spinner', () => {
    const { container } = renderRoute('/');

    expect(screen.getByRole('status', { name: /loading skills/i })).toBeInTheDocument();
    expect(container.querySelector('.skill-card-skeleton')).toBeInTheDocument();
    expect(container.querySelector('.spinner')).not.toBeInTheDocument();
  });

  it('shows a retryable registry error when browse skill loading fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'upstream failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));

    renderRoute('/');

    expect(await screen.findByRole('alert')).toHaveTextContent(/registry api is unreachable/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText(/registry unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/connected to registry/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no skills found/i)).not.toBeInTheDocument();
  });

  it('renders skill detail on direct non-root navigation', async () => {
    renderRoute('/skills/asr/security-review');

    expect(await screen.findByRole('heading', { name: /security-review/i })).toBeInTheDocument();
    expect(screen.getByText(/scanner output/i)).toBeInTheDocument();
  });

  it('renders the documented install command on skill detail', async () => {
    renderRoute('/skills/asr/security-review');

    expect(await screen.findByText('asr install asr/security-review')).toBeInTheDocument();
    expect(screen.queryByText(/asr add/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/asr install asr\/skills-registry\/security-review/i)).not.toBeInTheDocument();
  });

  it('renders the publish wizard on direct non-root navigation', () => {
    renderRoute('/publish');

    expect(screen.getByRole('heading', { name: /publish a skill/i })).toBeInTheDocument();
  });

  it('keeps publish wizard advancement disabled until upload fields are valid', () => {
    renderRoute('/publish');

    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /manifest/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /questionnaire/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /review & submit/i })).toBeDisabled();
  });

  it('keeps future publish steps locked after invalid archive validation', async () => {
    renderRoute('/publish');

    fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: 'asr' } });
    fireEvent.change(screen.getByLabelText(/skill.md/i), {
      target: {
        value: `---
name: valid-skill
version: 1.0.0
author: Platform Team
description: Valid skill.
---

Use this skill when testing upload validation.`,
      },
    });
    fireEvent.change(screen.getByLabelText(/skill archive/i), {
      target: {
        files: [createZipFile(['valid-skill/SKILL.md', 'valid-skill/README.txt'])],
      },
    });

    expect(await screen.findByText(/archive must include manifest.yaml/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /manifest/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /questionnaire/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /review & submit/i })).toBeDisabled();
    expect(screen.getByRole('heading', { name: /upload archive/i })).toBeInTheDocument();
  });

  it('keeps oversized archive validation after submit validation runs', async () => {
    const { container } = renderRoute('/publish');

    fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: 'asr' } });
    fireEvent.change(screen.getByLabelText(/skill.md/i), {
      target: {
        value: `---
name: valid-skill
version: 1.0.0
author: Platform Team
description: Valid skill.
---

Use this skill when testing upload validation.`,
      },
    });
    fireEvent.change(screen.getByLabelText(/skill archive/i), {
      target: {
        files: [new File([new Uint8Array(51 * 1024 * 1024)], 'oversized.zip', { type: 'application/zip' })],
      },
    });

    expect(await screen.findByText(/archive must be 50 mb or smaller/i)).toBeInTheDocument();

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    expect(screen.getByText(/archive must be 50 mb or smaller/i)).toBeInTheDocument();
    expect(screen.queryByText(/upload a skill archive/i)).not.toBeInTheDocument();
  });

  it('shows SKILL.md validation while upload advancement is disabled', async () => {
    renderRoute('/publish');

    fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: 'asr' } });
    fireEvent.change(screen.getByLabelText(/skill archive/i), {
      target: {
        files: [createZipFile(['valid-skill/manifest.yaml', 'valid-skill/SKILL.md'])],
      },
    });

    await waitFor(() => {
      expect(screen.queryByText(/archive must/i)).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/skill.md/i), {
      target: { value: 'name: invalid-skill' },
    });

    expect(screen.getByText(/skill.md must start with yaml frontmatter/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/skill.md/i)).toHaveAttribute('aria-describedby', 'publish-skill-md-error');
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled();
  });

  it('keeps later publish steps locked until each previous step is completed', async () => {
    renderRoute('/publish');

    fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: 'asr' } });
    fireEvent.change(screen.getByLabelText(/skill.md/i), {
      target: {
        value: `---
name: valid-skill
version: 1.0.0
author: Platform Team
description: Valid skill.
---

Use this skill when testing step navigation.`,
      },
    });
    fireEvent.change(screen.getByLabelText(/skill archive/i), {
      target: {
        files: [createZipFile(['valid-skill/manifest.yaml', 'valid-skill/SKILL.md'])],
      },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled();
    });

    expect(screen.getByRole('button', { name: /manifest/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /questionnaire/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /review & submit/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByRole('heading', { name: /review manifest/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manifest/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /questionnaire/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /review & submit/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByRole('heading', { name: /questionnaire/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /questionnaire/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /review & submit/i })).toBeDisabled();
  });

  it('rejects archive uploads that omit manifest.yaml from the root directory', async () => {
    renderRoute('/publish');

    fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: 'asr' } });
    fireEvent.change(screen.getByLabelText(/skill.md/i), {
      target: {
        value: `---
name: valid-skill
version: 1.0.0
author: Platform Team
description: Valid skill.
---

Use this skill when testing upload validation.`,
      },
    });
    fireEvent.change(screen.getByLabelText(/skill archive/i), {
      target: {
        files: [createZipFile(['valid-skill/SKILL.md', 'valid-skill/README.txt'])],
      },
    });

    expect(await screen.findByText(/archive must include manifest.yaml/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /review manifest/i })).not.toBeInTheDocument();
    });
  });

  it('renders a graceful inline 404 for unknown skill routes', () => {
    renderRoute('/skills/does-not-exist');

    expect(screen.getByRole('heading', { name: /skill not found/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /registry route error/i })).not.toBeInTheDocument();
  });
});
