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
      : { items: [] };

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
  it('routes review through the approval dashboard queue', async () => {
    renderRoute('/review');

    expect(await screen.findByRole('heading', { name: /approval dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /secure-code-review/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /release-notes/i })).toBeInTheDocument();
    expect(screen.getAllByText(/pending review/i)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^approve$/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^reject$/i })).toHaveLength(2);
  });

  it('renders approval detail evidence tabs and confirmation affordances', async () => {
    renderRoute('/review/sub-1042');

    expect(await screen.findByRole('heading', { name: /secure-code-review/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
    const skillDiff = screen.getByRole('region', { name: /SKILL\.md line-level diff/i });
    expect(skillDiff).toBeInTheDocument();
    expect(within(skillDiff).getByText(/Previous/i)).toBeInTheDocument();
    expect(within(skillDiff).getByText(/Submitted/i)).toBeInTheDocument();
    expect(within(skillDiff).getAllByText(/Review dependency changes before release/i).length).toBeGreaterThan(0);
    expect(within(skillDiff).getAllByText(/document compliance evidence/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /dependencies/i }));
    expect(screen.getByRole('columnheader', { name: /before/i })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /@actions\/core/i })).toBeInTheDocument();
    expect(screen.getAllByText(/runtime/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /permissions/i }));
    expect(screen.getByRole('heading', { name: /network/i })).toBeInTheDocument();
    expect(screen.getAllByText(/expanded capability/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/registry\.npmjs\.org/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /scan/i }));
    expect(screen.getByRole('group', { name: /filter scan findings by severity/i })).toBeInTheDocument();
    expect(screen.getByText(/dependency upgrade requires review/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^high$/i }));
    expect(screen.getByText(/subprocess capability requires justification/i)).toBeInTheDocument();
    expect(screen.queryByText(/no secrets detected/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    const dialog = screen.getByRole('dialog', { name: /approve submission/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/v1\.4\.0/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/high risk/i)).toBeInTheDocument();
  });

  it('uses the wrapped mobile diff layout for narrow review detail screens', async () => {
    stubMatchMedia(true);
    renderRoute('/review/sub-1039');

    expect(await screen.findByRole('heading', { name: /release-notes/i })).toBeInTheDocument();
    const diffRegion = screen.getByRole('region', { name: /SKILL\.md line-level diff/i });
    expect(diffRegion).toHaveClass('review-diff-viewer-mobile');
    expect(diffRegion.querySelector('table')).toBeInTheDocument();
    expect(diffRegion).toHaveTextContent(/dependency changes/i);
  });

  it('keeps the existing browse page on the index route', async () => {
    renderRoute('/');

    expect(await screen.findByRole('heading', { name: /agent skill registry/i })).toBeInTheDocument();
  });

  it('renders browse loading as content skeletons instead of a spinner', () => {
    const { container } = renderRoute('/');

    expect(screen.getByRole('status', { name: /loading skills/i })).toBeInTheDocument();
    expect(container.querySelector('.skill-card-skeleton')).toBeInTheDocument();
    expect(container.querySelector('.spinner')).not.toBeInTheDocument();
  });

  it('renders skill detail on direct non-root navigation', async () => {
    renderRoute('/skills/asr/security-review');

    expect(await screen.findByRole('heading', { name: /security-review/i })).toBeInTheDocument();
    expect(screen.getByText(/scanner output/i)).toBeInTheDocument();
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
