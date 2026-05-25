import { createContext, useState, useEffect, useCallback, useContext, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import ReactDiffViewer from 'react-diff-viewer-continued';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseSkillMd, type SkillDetail, type SkillSummary, type VersionDiff } from '@asr/core';

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

function useMediaQuery(query: string): boolean {
  const getMatches = useCallback(() => (
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  ), [query]);
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handleChange = () => setMatches(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
}

interface Skill {
  id: string;
  owner: string;
  name: string;
  description: string;
  tags: string[];
  stars: number;
  installs: number;
  version?: string;
  content?: string;
  updated_at: string;
}

interface ReviewSubmission {
  id: string;
  skillName: string;
  owner: string;
  version: string;
  submitter: string;
  submittedAt: string;
  status: 'pending review' | 'scanning' | 'awaiting confirmation' | 'approved' | 'rejected';
  risk: 'low' | 'medium' | 'high';
  findings: number;
}

interface ReviewSubmissionDetail {
  diff: ReviewDiffFile[];
  dependencies: { name: string; version: string; status: string }[];
  permissions: { label: string; value: string; risk: ReviewSubmission['risk'] }[];
  scan: { scanner: string; result: string; severity: ReviewSubmission['risk'] }[];
  audit: { actor: string; action: string; at: string }[];
}

interface ReviewDiffFile {
  file: string;
  summary: string;
  additions: number;
  removals: number;
  oldValue: string;
  newValue: string;
}

const API_URL = import.meta.env.VITE_API_URL || '';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_EMPTY_ARCHIVE_HEADER = 0x06054b50;
const ZIP_SPANNED_ARCHIVE_HEADER = 0x08074b50;
const ZIP_EOCD_HEADER = 0x06054b50;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_EOCD_MAX_COMMENT_BYTES = 0xffff;

interface RegistrySkillsResponse {
  items?: SkillSummary[];
}

type Decision = 'approved' | 'rejected';
type PublishStatus = 'idle' | 'submitting' | 'submitted';
type PublishWizardStep = 'upload' | 'manifest' | 'questionnaire' | 'review';
type SkillDetailTab = 'preview' | 'versions' | 'permissions' | 'audit';
type ReviewDetailTab = 'diff' | 'dependencies' | 'permissions' | 'scan' | 'audit';
type MockRole = 'Viewer' | 'Submitter' | 'Compliance' | 'Admin';

interface Session {
  role: MockRole;
  canSubmit: boolean;
  canReview: boolean;
}

interface PublishFormErrors {
  skillArchive?: string;
  skillMd?: string;
  owner?: string;
}

interface PublishManifestDraft {
  name: string;
  version: string;
  author: string;
  description: string;
  tags: string;
}

interface QuestionnaireDraft {
  externalNetwork: string;
  filesystemAccess: string;
  reviewNotes: string;
}

type ParsedSkillMd = ReturnType<typeof parseSkillMd>;

const publishWizardSteps: { id: PublishWizardStep; label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'questionnaire', label: 'Questionnaire' },
  { id: 'review', label: 'Review & Submit' },
];

const emptyManifestDraft: PublishManifestDraft = {
  name: '',
  version: '',
  author: '',
  description: '',
  tags: '',
};

const emptyQuestionnaireDraft: QuestionnaireDraft = {
  externalNetwork: '',
  filesystemAccess: '',
  reviewNotes: '',
};

const reviewRoles = new Set<MockRole>(['Compliance', 'Admin']);
const submitRoles = new Set<MockRole>(['Submitter', 'Admin']);
const mockRoles: MockRole[] = ['Viewer', 'Submitter', 'Compliance', 'Admin'];
const SessionContext = createContext<Session | null>(null);

function getMockRole(): MockRole {
  const configuredRole = import.meta.env.VITE_MOCK_AUTH_ROLE;
  if (mockRoles.includes(configuredRole as MockRole)) {
    return configuredRole as MockRole;
  }

  return 'Viewer';
}

function createSession(role: MockRole): Session {
  return {
    role,
    canSubmit: submitRoles.has(role),
    canReview: reviewRoles.has(role),
  };
}

function SessionProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => createSession(getMockRole()));
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error('useSession must be used inside SessionProvider');
  }

  return session;
}

function mapSkillSummary(skill: SkillSummary): Skill {
  return {
    id: `${skill.owner}/${skill.name}`,
    owner: skill.owner,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    stars: 0,
    installs: skill.downloadCount,
    version: skill.latestVersion,
    updated_at: skill.publishedAt,
  };
}

function getInstallCommand(owner: string, name: string): string {
  return `asr install ${owner}/${name}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatPermissionValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : 'none';
  }

  if (typeof value === 'boolean') {
    return value ? 'allowed' : 'blocked';
  }

  return String(value);
}

const skillDetailTabs: { id: SkillDetailTab; label: string }[] = [
  { id: 'preview', label: 'SKILL.md preview' },
  { id: 'versions', label: 'Versions' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'audit', label: 'Audit' },
];

const reviewDetailTabs: { id: ReviewDetailTab; label: string }[] = [
  { id: 'diff', label: 'Diff' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'scan', label: 'Scan' },
  { id: 'audit', label: 'Audit' },
];

function decodeRoutePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeRoutePart(value: string): string {
  return encodeURIComponent(value);
}

function getSkillVersionDiffPath(owner: string, name: string, version: string): string {
  return `/skills/${encodeRoutePart(owner)}/${encodeRoutePart(name)}/versions/${encodeRoutePart(version)}/diff`;
}

function getSkillPath(owner: string, name: string): string {
  return `/skills/${encodeRoutePart(owner)}/${encodeRoutePart(name)}`;
}

function getDecisionRequest(
  decision: Decision,
  reason: string,
): { endpoint: 'approve' | 'reject'; body: { comment?: string; reason?: string } } {
  if (decision === 'approved') {
    return { endpoint: 'approve', body: reason.trim() ? { comment: reason.trim() } : {} };
  }

  return { endpoint: 'reject', body: { reason: reason.trim() } };
}

function PrimaryNav({ current }: { current: 'browse' | 'publish' | 'review' }) {
  const session = useSession();

  return (
    <nav className="primary-nav" aria-label="Primary navigation">
      <a href="/" aria-current={current === 'browse' ? 'page' : undefined}>Browse</a>
      <a href="/publish" aria-current={current === 'publish' ? 'page' : undefined}>Publish</a>
      {session.canReview ? (
        <a href="/review" aria-current={current === 'review' ? 'page' : undefined}>Review</a>
      ) : null}
    </nav>
  );
}

function MockAuthBanner() {
  const session = useSession();
  return (
    <div
      className="mock-auth-banner"
      role="status"
      aria-label={`Development mock auth session: ${session.role}`}
    >
      Dev mock auth: {session.role}
    </div>
  );
}

function parsePublishSkillMd(content: string): ParsedSkillMd {
  try {
    return parseSkillMd(content);
  } catch {
    const match = content.match(/^---\n([\s\S]*?)\n---\n*([\s\S]*)$/);
    if (!match) {
      throw new Error('Missing frontmatter');
    }

    const data: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const separator = line.indexOf(':');
      if (separator === -1) {
        continue;
      }

      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      data[key] = value.replace(/^["']|["']$/g, '');
    }

    const tags = data.tags?.replace(/^\[|\]$/g, '')
      .split(',')
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean) ?? [];

    return {
      name: data.name || 'unnamed',
      description: data.description || '',
      tags,
      author: data.author,
      version: data.version,
      body: match[2].trim(),
    };
  }
}

function validateSkillMd(content: string): string | undefined {
  if (!content.trim()) {
    return 'Paste the SKILL.md content from the archive.';
  }

  if (!content.trimStart().startsWith('---')) {
    return 'SKILL.md must start with YAML frontmatter.';
  }

  try {
    const manifest = parsePublishSkillMd(content);
    if (!manifest.name || manifest.name === 'unnamed') {
      return 'SKILL.md frontmatter must include a name.';
    }
    if (!manifest.version) {
      return 'SKILL.md frontmatter must include a version.';
    }
    if (!manifest.description) {
      return 'SKILL.md frontmatter must include a description.';
    }
    if (!manifest.author) {
      return 'SKILL.md frontmatter must include an author.';
    }
    if (!manifest.body) {
      return 'SKILL.md must include instructions below the frontmatter.';
    }
  } catch {
    return 'SKILL.md frontmatter could not be parsed.';
  }

  return undefined;
}

function validateArchive(file: File | null): string | undefined {
  if (!file) {
    return 'Upload a skill archive.';
  }

  if (!file.name.toLowerCase().endsWith('.zip')) {
    return 'Upload a .zip archive.';
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return 'Archive must be 50 MB or smaller.';
  }

  return undefined;
}

async function validateZipArchive(file: File | null): Promise<string | undefined> {
  const archiveError = validateArchive(file);
  if (archiveError || !file) {
    return archiveError;
  }

  if (file.size < 4) {
    return 'Archive file is not a valid zip archive.';
  }

  const header = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
  if (![ZIP_LOCAL_FILE_HEADER, ZIP_EMPTY_ARCHIVE_HEADER, ZIP_SPANNED_ARCHIVE_HEADER].includes(header)) {
    return 'Archive file is not a valid zip archive.';
  }

  const tailLength = Math.min(file.size, ZIP_EOCD_MIN_BYTES + ZIP_EOCD_MAX_COMMENT_BYTES);
  const tailOffset = file.size - tailLength;
  const tail = new DataView(await file.slice(tailOffset).arrayBuffer());
  for (let offset = tail.byteLength - ZIP_EOCD_MIN_BYTES; offset >= 0; offset -= 1) {
    if (tail.getUint32(offset, true) === ZIP_EOCD_HEADER) {
      return undefined;
    }
  }

  return 'Archive file is not a valid zip archive.';
}

function getParsedSkillMd(content: string): ParsedSkillMd | null {
  if (validateSkillMd(content)) {
    return null;
  }

  try {
    return parsePublishSkillMd(content);
  } catch {
    return null;
  }
}

function createManifestDraft(content: string): PublishManifestDraft {
  const manifest = getParsedSkillMd(content);
  if (!manifest) {
    return emptyManifestDraft;
  }
  const tags = Array.isArray(manifest.tags)
    ? manifest.tags
    : String(manifest.tags ?? '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);

  return {
    name: manifest.name,
    version: manifest.version ?? '',
    author: manifest.author ?? '',
    description: manifest.description,
    tags: tags.join(', '),
  };
}

const mockReviewQueue: ReviewSubmission[] = [
  {
    id: 'sub-1042',
    skillName: 'secure-code-review',
    owner: 'platform',
    version: '1.4.0',
    submitter: 'maria.chen',
    submittedAt: '2026-05-24T08:35:00Z',
    status: 'pending review',
    risk: 'high',
    findings: 3,
  },
  {
    id: 'sub-1039',
    skillName: 'release-notes',
    owner: 'docs',
    version: '0.8.2',
    submitter: 'eli.warner',
    submittedAt: '2026-05-23T17:10:00Z',
    status: 'pending review',
    risk: 'medium',
    findings: 1,
  },
  {
    id: 'sub-1031',
    skillName: 'test-plan-writer',
    owner: 'qa',
    version: '2.1.1',
    submitter: 'nora.patel',
    submittedAt: '2026-05-23T11:42:00Z',
    status: 'awaiting confirmation',
    risk: 'low',
    findings: 0,
  },
];

const mockReviewDetails: Record<string, ReviewSubmissionDetail> = {
  'sub-1042': {
    diff: [
      {
        file: 'SKILL.md',
        summary: 'Adds secure review instructions and scanner guidance.',
        additions: 42,
        removals: 8,
        oldValue: `---
name: secure-review
version: 1.1.0
kind: workflow
---

# Secure Review

Review dependency changes before release.

## Steps

1. Read package manifests.
2. Check scanner output.
3. Summarize notable dependency changes.`,
        newValue: `---
name: secure-review
version: 1.2.0
kind: workflow
permissions:
  network: restricted
  filesystem: read-only
  subprocess: npm-audit
---

# Secure Review

Review dependency changes before release and document compliance evidence.

## Steps

1. Read package manifests and lockfiles.
2. Run dependency checks in the sandbox.
3. Verify scanner output for high-severity findings.
4. Summarize notable dependency changes with remediation status.

## Scanner Guidance

Escalate subprocess usage unless the command is pinned and read-only.`,
      },
      {
        file: 'scripts/check-deps.ts',
        summary: 'Adds dependency manifest checks before reporting.',
        additions: 27,
        removals: 0,
        oldValue: '',
        newValue: `import { readFile } from 'node:fs/promises';

interface DependencyCheck {
  name: string;
  version: string;
  pinned: boolean;
}

export async function checkDependencies(manifestPath: string): Promise<DependencyCheck[]> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };

  return Object.entries(manifest.dependencies ?? {}).map(([name, version]) => ({
    name,
    version,
    pinned: /^\\d+\\.\\d+\\.\\d+$/.test(version),
  }));
}`,
      },
    ],
    dependencies: [
      { name: '@actions/core', version: '1.10.1', status: 'Pinned' },
      { name: 'semver', version: '7.6.3', status: 'Allowed' },
    ],
    permissions: [
      { label: 'Network', value: 'Restricted to registry and advisory APIs', risk: 'medium' },
      { label: 'Filesystem', value: 'Read-only project workspace access', risk: 'low' },
      { label: 'Subprocess', value: 'Runs npm audit in sandbox', risk: 'high' },
    ],
    scan: [
      { scanner: 'Static policy', result: 'Requires subprocess justification', severity: 'high' },
      { scanner: 'Archive malware scan', result: 'No malware detected', severity: 'low' },
      { scanner: 'Secret scan', result: 'No secrets detected', severity: 'low' },
    ],
    audit: [
      { actor: 'maria.chen', action: 'Submitted skill archive', at: '2026-05-24T08:35:00Z' },
      { actor: 'asr-scanner', action: 'Completed security scan', at: '2026-05-24T08:38:00Z' },
      { actor: 'compliance', action: 'Opened review', at: '2026-05-24T08:44:00Z' },
    ],
  },
  'sub-1039': {
    diff: [
      {
        file: 'SKILL.md',
        summary: 'Updates release note drafting guidance for dependency and migration notes.',
        additions: 18,
        removals: 3,
        oldValue: `# Release Notes

Draft concise release notes from merged pull requests.

Include features, fixes, and known issues.`,
        newValue: `# Release Notes

Draft concise release notes from merged pull requests.

Include features, fixes, migration notes, dependency changes, and known issues.

Flag dependency upgrades that change runtime behavior or deployment steps.`,
      },
      {
        file: 'templates/changelog.md',
        summary: 'Adds a structured upgrade-impact section for reviewers.',
        additions: 12,
        removals: 0,
        oldValue: '',
        newValue: `## Upgrade Impact

- Runtime changes:
- Dependency changes:
- Required migrations:
- Rollback notes:

## Reviewer Checklist

- [ ] Breaking changes identified
- [ ] Migration guidance included
- [ ] Dependency risk noted`,
      },
    ],
    dependencies: [
      { name: 'markdown-it', version: '14.1.0', status: 'Allowed' },
    ],
    permissions: [
      { label: 'Network', value: 'No network access requested', risk: 'low' },
      { label: 'Filesystem', value: 'Reads repository markdown and changelog files', risk: 'medium' },
      { label: 'Subprocess', value: 'No subprocess execution requested', risk: 'low' },
    ],
    scan: [
      { scanner: 'Static policy', result: 'Filesystem read scope requires reviewer confirmation', severity: 'medium' },
      { scanner: 'Archive malware scan', result: 'No malware detected', severity: 'low' },
      { scanner: 'Secret scan', result: 'No secrets detected', severity: 'low' },
    ],
    audit: [
      { actor: 'eli.warner', action: 'Submitted skill archive', at: '2026-05-23T17:10:00Z' },
      { actor: 'asr-scanner', action: 'Completed security scan', at: '2026-05-23T17:12:00Z' },
      { actor: 'compliance', action: 'Opened review', at: '2026-05-23T17:18:00Z' },
    ],
  },
};

function createReviewDetail(submission: ReviewSubmission): ReviewSubmissionDetail {
  const findingSummary = submission.findings === 1
    ? '1 scan finding is awaiting compliance review.'
    : `${submission.findings} scan findings are awaiting compliance review.`;

  return {
    diff: [
      {
        file: 'SKILL.md',
        summary: `Initial review package for ${submission.skillName} v${submission.version}.`,
        additions: 1,
        removals: 0,
        oldValue: '',
        newValue: `# ${submission.skillName}

Initial review package for ${submission.owner}/${submission.skillName} v${submission.version}.`,
      },
    ],
    dependencies: [
      { name: 'Submitted archive', version: submission.version, status: 'Queued for registry review' },
    ],
    permissions: [
      { label: 'Submission risk', value: `${submission.risk} risk from scanner summary`, risk: submission.risk },
      { label: 'Review owner', value: submission.owner, risk: 'low' },
    ],
    scan: [
      {
        scanner: 'Security scan',
        result: findingSummary,
        severity: submission.risk,
      },
    ],
    audit: [
      { actor: submission.submitter, action: 'Submitted skill archive', at: submission.submittedAt },
      { actor: 'asr', action: 'Queued compliance review', at: submission.submittedAt },
    ],
  };
}

function createReviewDetailFromVersionDiff(submission: ReviewSubmission, diff: VersionDiff): ReviewSubmissionDetail {
  const baseDetail = createReviewDetail(submission);
  const changedFiles: ReviewDiffFile[] = [
    ...diff.filesModified.map((file) => ({
      file,
      summary: 'Modified in this version.',
      additions: 1,
      removals: 1,
      oldValue: `${file}\n\nPrevious version content is represented by the registry diff payload.`,
      newValue: `${file}\n\nUpdated content is represented by the registry diff payload.`,
    })),
    ...diff.filesAdded.map((file) => ({
      file,
      summary: 'Added in this version.',
      additions: 1,
      removals: 0,
      oldValue: '',
      newValue: `${file}\n\nAdded in ${diff.toVersion}.`,
    })),
    ...diff.filesRemoved.map((file) => ({
      file,
      summary: 'Removed in this version.',
      additions: 0,
      removals: 1,
      oldValue: `${file}\n\nRemoved after ${diff.fromVersion || 'initial publish'}.`,
      newValue: '',
    })),
  ];

  return {
    ...baseDetail,
    diff: changedFiles.length > 0 ? changedFiles : baseDetail.diff,
    permissions: [
      {
        label: 'Version risk',
        value: `${diff.riskAssessment} risk from registry version diff`,
        risk: diff.riskAssessment,
      },
      {
        label: 'Permissions',
        value: diff.permissionsExpanded ? 'Expanded from previous version' : 'No expansion detected',
        risk: diff.permissionsExpanded ? 'high' : 'low',
      },
      ...baseDetail.permissions.slice(1),
    ],
  };
}

async function fetchReviewVersionDiff(submission: ReviewSubmission): Promise<VersionDiff | null> {
  const res = await fetch(
    `${API_URL}/api/v1/submissions/${encodeURIComponent(submission.id)}/diff`,
  );

  if (res.status === 202 || res.status === 204) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`Submission diff request failed with ${res.status}`);
  }

  return await res.json() as VersionDiff | null;
}

function ReviewDiffPanel({ files }: { files: ReviewDiffFile[] }) {
  const isNarrowDiff = useMediaQuery('(max-width: 640px)');

  if (files.length === 0) {
    return <p className="empty-review-queue">No changed files are available for this submission.</p>;
  }

  return (
    <div className="review-diff-list">
      {files.map((file) => (
        <section className="review-diff-file" key={file.file} aria-label={`${file.file} diff`}>
          <header className="review-diff-file-header">
            <div>
              <h2>{file.file}</h2>
              <p>{file.summary}</p>
            </div>
            <span>+{file.additions} / -{file.removals}</span>
          </header>
          <div className="review-diff-viewer">
            <ReactDiffViewer
              oldValue={file.oldValue}
              newValue={file.newValue}
              splitView={!isNarrowDiff}
              showDiffOnly={false}
              leftTitle="Previous"
              rightTitle="Submitted"
              useDarkTheme={false}
            />
          </div>
        </section>
      ))}
    </div>
  );
}

function formatSubmittedAt(value: string): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function ReviewDashboard() {
  const [submissions, setSubmissions] = useState<ReviewSubmission[]>(() => (API_URL ? [] : mockReviewQueue));
  const [loading, setLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [decisionPending, setDecisionPending] = useState<Record<string, Decision>>({});
  const [decisionError, setDecisionError] = useState<Record<string, string>>({});
  const [decisionSuccess, setDecisionSuccess] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    submission: ReviewSubmission;
    decision: Decision;
  } | null>(null);
  const [decisionReason, setDecisionReason] = useState('');

  const fetchQueue = useCallback(async () => {
    setDecisionSuccess(null);
    if (!API_URL) {
      setQueueError(null);
      setSubmissions(mockReviewQueue);
      setLoading(false);
      return;
    }

    setLoading(true);
    setQueueError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/submissions?status=pending`);
      if (!res.ok) {
        throw new Error(`Queue request failed with ${res.status}`);
      }

      const data = await res.json();
      const items = Array.isArray(data.submissions) ? data.submissions : [];
      setSubmissions(items);
    } catch {
      setSubmissions([]);
      setQueueError('Unable to load pending submissions from the API.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  function requestDecisionConfirmation(submission: ReviewSubmission, decision: Decision) {
    setDecisionSuccess(null);
    setDecisionError((current) => {
      const next = { ...current };
      delete next[submission.id];
      return next;
    });
    setDecisionReason('');
    setPendingConfirmation({ submission, decision });
  }

  function closeDecisionConfirmation() {
    setPendingConfirmation(null);
    setDecisionReason('');
  }

  async function decideSubmission(id: string, decision: Decision, reason: string) {
    setDecisionPending((current) => ({ ...current, [id]: decision }));
    setDecisionError((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });

    try {
      if (API_URL) {
        const { endpoint, body } = getDecisionRequest(decision, reason);
        const res = await fetch(`${API_URL}/api/v1/submissions/${id}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error(`Decision request failed with ${res.status}`);
        }
      }

      setSubmissions((current) =>
        current.map((submission) => (submission.id === id ? { ...submission, status: decision } : submission)),
      );
      setDecisionSuccess(
        `${decision === 'approved' ? 'Approved' : 'Rejected'} ${pendingConfirmation?.submission.skillName ?? 'submission'}.`,
      );
      closeDecisionConfirmation();
    } catch {
      setDecisionError((current) => ({
        ...current,
        [id]: 'Decision could not be recorded. Try again after the API is available.',
      }));
    } finally {
      setDecisionPending((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  }

  const reviewableSubmissions = submissions.filter((submission) => submission.status === 'pending review');
  const pendingCount = reviewableSubmissions.length;
  const findingCount = reviewableSubmissions.reduce((total, submission) => total + submission.findings, 0);
  const pendingSubmissionCopy =
    queueError
      ? 'Pending submissions could not be loaded'
      : pendingCount === 1
        ? '1 submission needs compliance review'
        : `${pendingCount} submissions need compliance review`;
  const confirmationSubmitDisabled =
    pendingConfirmation?.decision === 'rejected' && decisionReason.trim().length === 0;
  const confirmationPending = pendingConfirmation
    ? decisionPending[pendingConfirmation.submission.id] === pendingConfirmation.decision
    : false;
  const confirmationError = pendingConfirmation ? decisionError[pendingConfirmation.submission.id] : null;

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container review-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </a>
          <PrimaryNav current="review" />
          <MockAuthBanner />
        </div>
      </header>

      <main className="review-main">
        <div className="container">
          <section className="review-hero" aria-labelledby="review-title">
            <div>
              <p className="eyebrow">Compliance queue</p>
              <h1 id="review-title">Approval dashboard</h1>
              <p>Review pending skill submissions, inspect scan results, and record approval decisions.</p>
            </div>
            <div className="review-summary" aria-label="Approval queue summary">
              <div>
                <strong>{pendingCount}</strong>
                <span>Pending</span>
              </div>
              <div>
                <strong>{findingCount}</strong>
                <span>Findings</span>
              </div>
            </div>
          </section>

          <section className="review-panel" aria-label="Pending submissions">
            <div className="review-panel-header">
              <div>
                <h2>Pending submissions</h2>
                <p>
                  {loading
                    ? 'Refreshing queue...'
                    : pendingSubmissionCopy}
                </p>
              </div>
              <button className="secondary-btn" type="button" onClick={fetchQueue} disabled={loading}>
                Refresh
              </button>
            </div>

            {queueError ? (
              <div className="queue-error" role="alert">
                <span>{queueError}</span>
                <button className="queue-error-retry" type="button" onClick={fetchQueue} disabled={loading}>
                  Retry
                </button>
              </div>
            ) : null}
            {decisionSuccess ? (
              <div className="decision-success" role="status">{decisionSuccess}</div>
            ) : null}

            <div className="submission-list">
              {reviewableSubmissions.length === 0 && !loading && !queueError ? (
                <div className="empty-review-queue" role="status">No pending submissions need compliance review.</div>
              ) : null}

              {reviewableSubmissions.map((submission) => {
                const pendingDecision = decisionPending[submission.id];
                const isReviewable = submission.status === 'pending review';
                const disableActions = Boolean(pendingDecision);

                return (
                  <article className="submission-row" key={submission.id}>
                    <div className="submission-primary">
                      <div className="submission-title-line">
                        <h3>{submission.skillName}</h3>
                        <span className={`status-pill status-${submission.status.replace(/\s/g, '-')}`}>
                          {submission.status}
                        </span>
                      </div>
                      <p>{submission.owner} - v{submission.version} - submitted by {submission.submitter}</p>
                      <div className="submission-meta">
                        <span>{formatSubmittedAt(submission.submittedAt)}</span>
                        <span className={`risk-pill risk-${submission.risk}`}>{submission.risk} risk</span>
                        <span>{submission.findings} scan findings</span>
                      </div>
                      {decisionError[submission.id] ? (
                        <p className="decision-error" role="status">{decisionError[submission.id]}</p>
                      ) : null}
                    </div>
                    <div className="decision-actions" aria-label={`Decision actions for ${submission.skillName}`}>
                      <a className="review-detail-link" href={`/review/${submission.id}`}>
                        Open details
                      </a>
                      {isReviewable ? (
                        <>
                          <button
                            className="approve-btn"
                            type="button"
                            onClick={() => requestDecisionConfirmation(submission, 'approved')}
                            disabled={disableActions}
                          >
                            {pendingDecision === 'approved' ? 'Approving...' : 'Approve'}
                          </button>
                          <button
                            className="reject-btn"
                            type="button"
                            onClick={() => requestDecisionConfirmation(submission, 'rejected')}
                            disabled={disableActions}
                          >
                            {pendingDecision === 'rejected' ? 'Rejecting...' : 'Reject'}
                          </button>
                        </>
                      ) : (
                        <span className="decision-unavailable">
                          Awaiting submitter confirmation
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </main>

      {pendingConfirmation ? (
        <div className="decision-modal-backdrop" role="presentation">
          <section
            className="decision-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="decision-modal-title"
          >
            <div className="decision-modal-header">
              <div>
                <p className="eyebrow">Confirm decision</p>
                <h2 id="decision-modal-title">
                  {pendingConfirmation.decision === 'approved' ? 'Approve submission' : 'Reject submission'}
                </h2>
              </div>
              <button
                className="icon-close-btn"
                type="button"
                aria-label="Close confirmation"
                onClick={closeDecisionConfirmation}
                disabled={confirmationPending}
              >
                x
              </button>
            </div>

            <dl className="decision-confirmation-facts">
              <div>
                <dt>Skill</dt>
                <dd>{pendingConfirmation.submission.skillName}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>v{pendingConfirmation.submission.version}</dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd className={`risk-text risk-text-${pendingConfirmation.submission.risk}`}>
                  {pendingConfirmation.submission.risk} risk
                </dd>
              </div>
            </dl>

            <label className="decision-reason-field" htmlFor="decision-reason">
              <span>{pendingConfirmation.decision === 'rejected' ? 'Reject reason' : 'Reviewer comment'}</span>
              <textarea
                id="decision-reason"
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                placeholder={
                  pendingConfirmation.decision === 'rejected'
                    ? 'Summarize the compliance issue blocking approval.'
                    : 'Optional approval note.'
                }
                required={pendingConfirmation.decision === 'rejected'}
                rows={4}
                disabled={confirmationPending}
              />
            </label>

            {pendingConfirmation.decision === 'rejected' && confirmationSubmitDisabled ? (
              <p className="decision-help">A rejection reason is required before submitting.</p>
            ) : null}
            {confirmationError ? (
              <p className="decision-error decision-modal-error" role="alert">{confirmationError}</p>
            ) : null}

            <div className="decision-modal-actions">
              <button
                className="secondary-btn"
                type="button"
                onClick={closeDecisionConfirmation}
                disabled={confirmationPending}
              >
                Cancel
              </button>
              <button
                className={pendingConfirmation.decision === 'approved' ? 'approve-btn' : 'reject-btn'}
                type="button"
                onClick={() =>
                  decideSubmission(
                    pendingConfirmation.submission.id,
                    pendingConfirmation.decision,
                    decisionReason,
                  )
                }
                disabled={confirmationPending || confirmationSubmitDisabled}
              >
                {confirmationPending
                  ? pendingConfirmation.decision === 'approved'
                    ? 'Approving...'
                    : 'Rejecting...'
                  : pendingConfirmation.decision === 'approved'
                    ? 'Confirm approval'
                    : 'Confirm rejection'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ReviewDetailPage({ submissionId }: { submissionId: string }) {
  const mockSubmission = mockReviewQueue.find((item) => item.id === submissionId) ?? null;
  const [submission, setSubmission] = useState<ReviewSubmission | null>(mockSubmission);
  const [detail, setDetail] = useState<ReviewSubmissionDetail | null>(() =>
    mockSubmission ? (mockReviewDetails[submissionId] ?? createReviewDetail(mockSubmission)) : null,
  );
  const [loading, setLoading] = useState(Boolean(API_URL && !mockSubmission));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ReviewDetailTab>('diff');
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionPending, setDecisionPending] = useState<Decision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionSuccess, setDecisionSuccess] = useState<string | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<Decision | null>(null);

  useEffect(() => {
    let ignore = false;

    async function fetchSubmission() {
      if (mockSubmission) {
        setSubmission(mockSubmission);
        setDetail(mockReviewDetails[submissionId] ?? createReviewDetail(mockSubmission));
        setLoadError(null);
        setLoading(false);
        return;
      }

      if (!API_URL) {
        setSubmission(null);
        setDetail(null);
        setLoadError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`${API_URL}/api/v1/submissions?status=pending`);
        if (!res.ok) {
          throw new Error(`Submission request failed with ${res.status}`);
        }

        const data = await res.json();
        const items = Array.isArray(data.submissions) ? data.submissions as ReviewSubmission[] : [];
        const nextSubmission = items.find((item) => item.id === submissionId) ?? null;
        const versionDiff = nextSubmission ? await fetchReviewVersionDiff(nextSubmission) : null;
        if (!ignore) {
          setSubmission(nextSubmission);
          setDetail(
            nextSubmission
              ? versionDiff
                ? createReviewDetailFromVersionDiff(nextSubmission, versionDiff)
                : createReviewDetail(nextSubmission)
              : null,
          );
        }
      } catch {
        if (!ignore) {
          setSubmission(null);
          setDetail(null);
          setLoadError('Unable to load this submission from the API.');
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    fetchSubmission();

    return () => {
      ignore = true;
    };
  }, [mockSubmission, submissionId]);

  if (loading) {
    return (
      <SkillNotFoundState
        title="Loading submission"
        message={`Loading review evidence for ${submissionId}.`}
      />
    );
  }

  if (!submission || !detail) {
    return (
      <SkillNotFoundState
        title="Submission not found"
        message={loadError ?? `No review submission exists for ${submissionId}. Return to the approval dashboard and choose another item.`}
      />
    );
  }

  const canDecide = submission.status === 'pending review';
  const rejectDisabled = decisionReason.trim().length === 0;
  const confirmationSubmitDisabled = pendingConfirmation === 'rejected' && rejectDisabled;
  const confirmationPending = pendingConfirmation ? decisionPending === pendingConfirmation : false;

  function requestDecisionConfirmation(nextDecision: Decision) {
    setDecisionError(null);
    setDecisionSuccess(null);
    setPendingConfirmation(nextDecision);
  }

  function closeDecisionConfirmation() {
    if (!confirmationPending) {
      setPendingConfirmation(null);
    }
  }

  async function submitDecision(nextDecision: Decision) {
    const currentSubmission = submission;
    if (!currentSubmission) {
      return;
    }

    setDecisionPending(nextDecision);
    setDecisionError(null);
    setDecisionSuccess(null);

    try {
      if (API_URL) {
        const { endpoint, body } = getDecisionRequest(nextDecision, decisionReason);
        const res = await fetch(`${API_URL}/api/v1/submissions/${currentSubmission.id}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error(`Decision request failed with ${res.status}`);
        }
      }

      setDecision(nextDecision);
      setSubmission((current) =>
        current?.id === currentSubmission.id ? { ...current, status: nextDecision } : current,
      );
      setDecisionSuccess(`${nextDecision === 'approved' ? 'Approved' : 'Rejected'} ${currentSubmission.skillName}.`);
      setPendingConfirmation(null);
    } catch {
      setDecisionError('Decision could not be recorded. Try again after the API is available.');
    } finally {
      setDecisionPending(null);
    }
  }

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container review-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </a>
          <PrimaryNav current="review" />
          <MockAuthBanner />
        </div>
      </header>

      <main className="review-main">
        <div className="container review-detail-layout">
          <article className="review-detail-content">
            <a className="secondary-link" href="/review">Back to queue</a>
            <section className="review-hero review-detail-hero" aria-labelledby="review-detail-title">
              <div>
                <p className="eyebrow">Submission {submission.id}</p>
                <h1 id="review-detail-title">{submission.skillName}</h1>
                <p>{submission.owner} - v{submission.version} - submitted by {submission.submitter}</p>
              </div>
              <div className="review-summary" aria-label="Submission review summary">
                <div>
                  <strong className={`risk-text risk-text-${submission.risk}`}>{submission.risk}</strong>
                  <span>Risk</span>
                </div>
                <div>
                  <strong>{submission.findings}</strong>
                  <span>Findings</span>
                </div>
              </div>
            </section>

            <div className="review-detail-tabs" role="tablist" aria-label="Review evidence sections">
              {reviewDetailTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={activeTab === tab.id ? 'active' : undefined}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <section className="review-detail-panel" role="tabpanel" aria-label={reviewDetailTabs.find((tab) => tab.id === activeTab)?.label}>
              {activeTab === 'diff' && (
                <ReviewDiffPanel files={detail.diff} />
              )}

              {activeTab === 'dependencies' && (
                <div className="evidence-list">
                  {detail.dependencies.map((dependency) => (
                    <div className="evidence-row" key={dependency.name}>
                      <div>
                        <strong>{dependency.name}</strong>
                        <p>Version {dependency.version}</p>
                      </div>
                      <span>{dependency.status}</span>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'permissions' && (
                <div className="evidence-list">
                  {detail.permissions.map((permission) => (
                    <div className="evidence-row" key={permission.label}>
                      <div>
                        <strong>{permission.label}</strong>
                        <p>{permission.value}</p>
                      </div>
                      <span className={`risk-pill risk-${permission.risk}`}>{permission.risk}</span>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'scan' && (
                <div className="evidence-list">
                  {detail.scan.map((scan) => (
                    <div className="evidence-row" key={scan.scanner}>
                      <div>
                        <strong>{scan.scanner}</strong>
                        <p>{scan.result}</p>
                      </div>
                      <span className={`risk-pill risk-${scan.severity}`}>{scan.severity}</span>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'audit' && (
                <div className="evidence-list">
                  {detail.audit.map((event) => (
                    <div className="evidence-row" key={`${event.actor}-${event.at}`}>
                      <div>
                        <strong>{event.action}</strong>
                        <p>{event.actor}</p>
                      </div>
                      <span>{formatSubmittedAt(event.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </article>

          <aside className="decision-panel" aria-labelledby="decision-panel-title">
            <p className="eyebrow">Decision</p>
            <h2 id="decision-panel-title">Compliance action</h2>
            <dl className="decision-facts">
              <div>
                <dt>Status</dt>
                <dd>{decision ?? submission.status}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{formatSubmittedAt(submission.submittedAt)}</dd>
              </div>
            </dl>
            <label className="decision-reason-field" htmlFor="review-decision-reason">
              <span>Reviewer note</span>
              <textarea
                id="review-decision-reason"
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                rows={5}
                placeholder="Record approval context or rejection reason."
                disabled={!canDecide || Boolean(decision)}
              />
            </label>
            {canDecide && !decision && rejectDisabled ? (
              <p className="decision-help">A rejection reason is required before rejecting.</p>
            ) : null}
            {decisionSuccess ? (
              <p className="decision-success" role="status">{decisionSuccess}</p>
            ) : null}
            {decisionError ? (
              <p className="decision-error decision-modal-error" role="alert">{decisionError}</p>
            ) : null}
            <div className="decision-panel-actions">
              <button
                className="approve-btn"
                type="button"
                onClick={() => requestDecisionConfirmation('approved')}
                disabled={!canDecide || Boolean(decision) || Boolean(decisionPending)}
              >
                {decisionPending === 'approved' ? 'Approving...' : decision === 'approved' ? 'Approved' : 'Approve'}
              </button>
              <button
                className="reject-btn"
                type="button"
                onClick={() => requestDecisionConfirmation('rejected')}
                disabled={!canDecide || Boolean(decision) || Boolean(decisionPending) || rejectDisabled}
              >
                {decisionPending === 'rejected' ? 'Rejecting...' : decision === 'rejected' ? 'Rejected' : 'Reject'}
              </button>
            </div>
          </aside>
        </div>
      </main>

      {pendingConfirmation ? (
        <div className="decision-modal-backdrop" role="presentation">
          <section
            className="decision-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-decision-modal-title"
          >
            <div className="decision-modal-header">
              <div>
                <p className="eyebrow">Confirm decision</p>
                <h2 id="review-decision-modal-title">
                  {pendingConfirmation === 'approved' ? 'Approve submission' : 'Reject submission'}
                </h2>
              </div>
              <button
                className="icon-close-btn"
                type="button"
                aria-label="Close confirmation"
                onClick={closeDecisionConfirmation}
                disabled={confirmationPending}
              >
                x
              </button>
            </div>

            <dl className="decision-confirmation-facts">
              <div>
                <dt>Skill</dt>
                <dd>{submission.skillName}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>v{submission.version}</dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd className={`risk-text risk-text-${submission.risk}`}>
                  {submission.risk} risk
                </dd>
              </div>
            </dl>

            <label className="decision-reason-field" htmlFor="review-decision-confirmation-reason">
              <span>{pendingConfirmation === 'rejected' ? 'Reject reason' : 'Reviewer comment'}</span>
              <textarea
                id="review-decision-confirmation-reason"
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                placeholder={
                  pendingConfirmation === 'rejected'
                    ? 'Summarize the compliance issue blocking approval.'
                    : 'Optional approval note.'
                }
                required={pendingConfirmation === 'rejected'}
                rows={4}
                disabled={confirmationPending}
              />
            </label>

            {pendingConfirmation === 'rejected' && confirmationSubmitDisabled ? (
              <p className="decision-help">A rejection reason is required before submitting.</p>
            ) : null}
            {decisionError ? (
              <p className="decision-error decision-modal-error" role="alert">{decisionError}</p>
            ) : null}

            <div className="decision-modal-actions">
              <button
                className="secondary-btn"
                type="button"
                onClick={closeDecisionConfirmation}
                disabled={confirmationPending}
              >
                Cancel
              </button>
              <button
                className={pendingConfirmation === 'approved' ? 'approve-btn' : 'reject-btn'}
                type="button"
                onClick={() => submitDecision(pendingConfirmation)}
                disabled={confirmationPending || confirmationSubmitDisabled}
              >
                {confirmationPending
                  ? pendingConfirmation === 'approved'
                    ? 'Approving...'
                    : 'Rejecting...'
                  : pendingConfirmation === 'approved'
                    ? 'Confirm approval'
                    : 'Confirm rejection'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function PublishSkill() {
  const session = useSession();
  const archiveSelectionId = useRef(0);
  const [owner, setOwner] = useState('');
  const [skillMd, setSkillMd] = useState('');
  const [skillArchive, setSkillArchive] = useState<File | null>(null);
  const [currentStep, setCurrentStep] = useState<PublishWizardStep>('upload');
  const [manifestDraft, setManifestDraft] = useState<PublishManifestDraft>(emptyManifestDraft);
  const [questionnaire, setQuestionnaire] = useState<QuestionnaireDraft>(emptyQuestionnaireDraft);
  const [errors, setErrors] = useState<PublishFormErrors>({});
  const [status, setStatus] = useState<PublishStatus>('idle');
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  const uploadIsValid = Boolean(owner.trim() && skillArchive && getParsedSkillMd(skillMd));
  const manifestIsValid = Boolean(
    manifestDraft.name.trim()
      && manifestDraft.version.trim()
      && manifestDraft.author.trim()
      && manifestDraft.description.trim(),
  );
  const questionnaireIsValid = Boolean(questionnaire.externalNetwork && questionnaire.filesystemAccess);
  const canSubmit = session.canSubmit && uploadIsValid && manifestIsValid && questionnaireIsValid && status === 'idle';
  const archiveSize = skillArchive ? `${(skillArchive.size / 1024 / 1024).toFixed(2)} MB` : null;
  const manifestTags = manifestDraft.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  function validateUploadStep() {
    const nextErrors: PublishFormErrors = {};

    if (!owner.trim()) {
      nextErrors.owner = 'A registry owner or namespace is required.';
    }

    const archiveError = skillArchive
      ? validateArchive(skillArchive)
      : errors.skillArchive ?? validateArchive(skillArchive);
    if (archiveError) {
      nextErrors.skillArchive = archiveError;
    }

    const skillMdError = validateSkillMd(skillMd);
    if (skillMdError) {
      nextErrors.skillMd = skillMdError;
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function goToStep(step: PublishWizardStep) {
    const targetIndex = publishWizardSteps.findIndex((item) => item.id === step);
    const currentIndex = publishWizardSteps.findIndex((item) => item.id === currentStep);

    if (targetIndex <= currentIndex) {
      setCurrentStep(step);
      return;
    }

    if (!validateUploadStep()) {
      setCurrentStep('upload');
      return;
    }

    if (targetIndex > 1 && !manifestIsValid) {
      setCurrentStep('manifest');
      return;
    }

    if (targetIndex > 2 && !questionnaireIsValid) {
      setCurrentStep('questionnaire');
      return;
    }

    setCurrentStep(step);
  }

  function continueFromUpload() {
    setSubmitMessage(null);
    if (!validateUploadStep()) {
      return;
    }

    setManifestDraft(createManifestDraft(skillMd));
    setCurrentStep('manifest');
  }

  async function submitSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitMessage(null);

    if (status !== 'idle') {
      return;
    }

    if (!session.canSubmit) {
      setSubmitMessage('Submitter role required to publish skills.');
      return;
    }

    if (!validateUploadStep() || !skillArchive || !manifestIsValid || !questionnaireIsValid) {
      if (!manifestIsValid) {
        setCurrentStep('manifest');
      } else if (!questionnaireIsValid) {
        setCurrentStep('questionnaire');
      }
      return;
    }

    setStatus('submitting');
    try {
      if (API_URL) {
        const body = new FormData();
        body.set('owner', owner.trim());
        body.set('skillMd', skillMd);
        body.set('archive', skillArchive);

        const res = await fetch(`${API_URL}/api/v1/submissions`, {
          method: 'POST',
          body,
        });

        if (!res.ok) {
          throw new Error(`Submission request failed with ${res.status}`);
        }

        setSubmitMessage('Submission created and queued for scanning.');
      } else {
        setSubmitMessage('Submission validated. Configure VITE_API_URL to send it to the registry API.');
      }
      setStatus('submitted');
    } catch {
      setSubmitMessage('Submission could not be created. Try again after the API is available.');
      setStatus('idle');
    }
  }

  async function selectArchive(file: File | null, input: HTMLInputElement) {
    const selectionId = archiveSelectionId.current + 1;
    archiveSelectionId.current = selectionId;
    setSkillArchive(null);

    const archiveError = await validateZipArchive(file);
    if (archiveSelectionId.current !== selectionId) {
      return;
    }

    if (archiveError) {
      setSkillArchive(null);
      setErrors((current) => ({ ...current, skillArchive: archiveError }));
      input.value = '';
      return;
    }

    setSkillArchive(file);
    setErrors((current) => {
      const next = { ...current };
      delete next.skillArchive;
      return next;
    });
  }

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </a>
          <PrimaryNav current="publish" />
          <MockAuthBanner />
        </div>
      </header>

      <main className="publish-main">
        <div className="container publish-layout">
          <section className="publish-intro" aria-labelledby="publish-title">
            <p className="eyebrow">Skill submission</p>
            <h1 id="publish-title">Publish a skill</h1>
            <p>
              Upload an archive, confirm the parsed manifest, complete review questions, and submit for approval.
            </p>
          </section>

          <form className="publish-form publish-wizard" onSubmit={submitSkill} noValidate>
            <ol className="wizard-progress" aria-label="Submission steps">
              {publishWizardSteps.map((step, index) => {
                const isActive = currentStep === step.id;
                const isComplete =
                  (step.id === 'upload' && uploadIsValid)
                  || (step.id === 'manifest' && manifestIsValid)
                  || (step.id === 'questionnaire' && questionnaireIsValid)
                  || (step.id === 'review' && status === 'submitted');

                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => goToStep(step.id)}
                      aria-current={isActive ? 'step' : undefined}
                      data-complete={isComplete}
                    >
                      <span>{index + 1}</span>
                      {step.label}
                    </button>
                  </li>
                );
              })}
            </ol>

            {currentStep === 'upload' ? (
              <section className="wizard-panel" aria-labelledby="publish-upload-title">
                <div className="wizard-panel-header">
                  <p className="eyebrow">Step 1</p>
                  <h2 id="publish-upload-title">Upload archive</h2>
                </div>
                <label className="field" htmlFor="publish-owner">
                  <span>Registry owner</span>
                  <input
                    id="publish-owner"
                    type="text"
                    value={owner}
                    onChange={(event) => {
                      setOwner(event.target.value);
                      if (errors.owner) {
                        setErrors((current) => ({ ...current, owner: undefined }));
                      }
                    }}
                    placeholder="platform"
                    aria-invalid={Boolean(errors.owner)}
                    aria-describedby={errors.owner ? 'publish-owner-error' : undefined}
                  />
                  {errors.owner ? <small id="publish-owner-error" role="status">{errors.owner}</small> : null}
                </label>

                <label
                  className="field file-field archive-dropzone"
                  htmlFor="publish-archive"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files?.[0] ?? null;
                    const input = document.getElementById('publish-archive') as HTMLInputElement | null;
                    if (input) {
                      void selectArchive(file, input);
                    }
                  }}
                >
                  <span>Skill archive</span>
                  <strong>{skillArchive ? skillArchive.name : 'Drop zip archive here'}</strong>
                  <em>{archiveSize ? `${archiveSize} selected` : 'Zip archive, 50 MB maximum.'}</em>
                  <input
                    id="publish-archive"
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(event) => void selectArchive(event.target.files?.[0] ?? null, event.currentTarget)}
                    aria-invalid={Boolean(errors.skillArchive)}
                    aria-describedby={errors.skillArchive ? 'publish-archive-error' : undefined}
                  />
                  {errors.skillArchive ? (
                    <small id="publish-archive-error" role="status">{errors.skillArchive}</small>
                  ) : null}
                </label>

                <label className="field" htmlFor="publish-skill-md">
                  <span>SKILL.md</span>
                  <textarea
                    id="publish-skill-md"
                    value={skillMd}
                    onChange={(event) => {
                      setSkillMd(event.target.value);
                      setManifestDraft(createManifestDraft(event.target.value));
                      if (errors.skillMd) {
                        setErrors((current) => ({ ...current, skillMd: undefined }));
                      }
                    }}
                    rows={10}
                    placeholder={'---\nname: secure-code-review\nversion: 1.0.0\nauthor: Platform Team\ndescription: Review code for security issues.\ntags: [security, review]\n---\n\nUse this skill when...'}
                    aria-invalid={Boolean(errors.skillMd)}
                    aria-describedby={errors.skillMd ? 'publish-skill-md-error' : undefined}
                  />
                  {errors.skillMd ? <small id="publish-skill-md-error" role="status">{errors.skillMd}</small> : null}
                </label>
              </section>
            ) : null}

            {currentStep === 'manifest' ? (
              <section className="wizard-panel" aria-labelledby="publish-manifest-title">
                <div className="wizard-panel-header">
                  <p className="eyebrow">Step 2</p>
                  <h2 id="publish-manifest-title">Review manifest</h2>
                </div>
                <div className="manifest-grid">
                  <div className="field manifest-review-field">
                    <span>Name</span>
                    <strong>{manifestDraft.name || 'Missing'}</strong>
                  </div>
                  <div className="field manifest-review-field">
                    <span>Version</span>
                    <strong>{manifestDraft.version || 'Missing'}</strong>
                  </div>
                  <div className="field manifest-review-field">
                    <span>Author</span>
                    <strong>{manifestDraft.author || 'Missing'}</strong>
                  </div>
                  <div className="field manifest-review-field">
                    <span>Tags</span>
                    <strong>{manifestTags.length > 0 ? manifestTags.join(', ') : 'None'}</strong>
                  </div>
                </div>
                <div className="field manifest-review-field manifest-review-description">
                  <span>Description</span>
                  <p>{manifestDraft.description || 'Missing'}</p>
                </div>
                <dl className="derived-manifest">
                  <div>
                    <dt>Kind</dt>
                    <dd>skill</dd>
                  </div>
                  <div>
                    <dt>Permissions</dt>
                    <dd>Derived during server-side classification</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            {currentStep === 'questionnaire' ? (
              <section className="wizard-panel" aria-labelledby="publish-questionnaire-title">
                <div className="wizard-panel-header">
                  <p className="eyebrow">Step 3</p>
                  <h2 id="publish-questionnaire-title">Questionnaire</h2>
                </div>
                <fieldset className="question-group">
                  <legend>Does this skill require external network access?</legend>
                  <label>
                    <input
                      type="radio"
                      name="external-network"
                      value="yes"
                      checked={questionnaire.externalNetwork === 'yes'}
                      onChange={(event) => setQuestionnaire((current) => ({ ...current, externalNetwork: event.target.value }))}
                    />
                    Yes
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="external-network"
                      value="no"
                      checked={questionnaire.externalNetwork === 'no'}
                      onChange={(event) => setQuestionnaire((current) => ({ ...current, externalNetwork: event.target.value }))}
                    />
                    No
                  </label>
                </fieldset>
                <label className="field" htmlFor="publish-filesystem-access">
                  <span>Filesystem access</span>
                  <select
                    id="publish-filesystem-access"
                    value={questionnaire.filesystemAccess}
                    onChange={(event) => setQuestionnaire((current) => ({ ...current, filesystemAccess: event.target.value }))}
                  >
                    <option value="">Select access level</option>
                    <option value="none">None</option>
                    <option value="read-own">Read own files</option>
                    <option value="read-write-own">Read and write own files</option>
                  </select>
                </label>
                <label className="field" htmlFor="publish-review-notes">
                  <span>Reviewer notes</span>
                  <textarea
                    id="publish-review-notes"
                    value={questionnaire.reviewNotes}
                    onChange={(event) => setQuestionnaire((current) => ({ ...current, reviewNotes: event.target.value }))}
                    rows={5}
                    placeholder="Add context for compliance review."
                  />
                </label>
              </section>
            ) : null}

            {currentStep === 'review' ? (
              <section className="wizard-panel" aria-labelledby="publish-review-title">
                <div className="wizard-panel-header">
                  <p className="eyebrow">Step 4</p>
                  <h2 id="publish-review-title">Review & submit</h2>
                </div>
                <dl className="publish-review-summary">
                  <div>
                    <dt>Owner</dt>
                    <dd>{owner || 'Missing'}</dd>
                  </div>
                  <div>
                    <dt>Archive</dt>
                    <dd>{skillArchive ? `${skillArchive.name} (${archiveSize})` : 'Missing'}</dd>
                  </div>
                  <div>
                    <dt>Skill</dt>
                    <dd>{manifestDraft.name || 'Missing'} {manifestDraft.version ? `v${manifestDraft.version}` : ''}</dd>
                  </div>
                  <div>
                    <dt>Tags</dt>
                    <dd>{manifestTags.length > 0 ? manifestTags.join(', ') : 'None'}</dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd>{questionnaire.externalNetwork || 'Missing'}</dd>
                  </div>
                  <div>
                    <dt>Filesystem</dt>
                    <dd>{questionnaire.filesystemAccess || 'Missing'}</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            {submitMessage ? <div className="publish-message" role="status">{submitMessage}</div> : null}

            <div className="publish-actions">
              <a className="secondary-link" href="/">Cancel</a>
              {currentStep !== 'upload' ? (
                <button
                  className="secondary-btn"
                  type="button"
                  onClick={() => {
                    const currentIndex = publishWizardSteps.findIndex((step) => step.id === currentStep);
                    setCurrentStep(publishWizardSteps[Math.max(0, currentIndex - 1)].id);
                  }}
                >
                  Back
                </button>
              ) : null}
              {currentStep === 'upload' ? (
                <button className="submit-btn" type="button" onClick={continueFromUpload}>
                  Continue
                </button>
              ) : null}
              {currentStep === 'manifest' ? (
                <button
                  className="submit-btn"
                  type="button"
                  onClick={() => setCurrentStep('questionnaire')}
                  disabled={!manifestIsValid}
                >
                  Continue
                </button>
              ) : null}
              {currentStep === 'questionnaire' ? (
                <button
                  className="submit-btn"
                  type="button"
                  onClick={() => setCurrentStep('review')}
                  disabled={!questionnaireIsValid}
                >
                  Continue
                </button>
              ) : null}
              {currentStep === 'review' ? (
                <button className="submit-btn" type="submit" disabled={!canSubmit}>
                  {status === 'submitted' ? 'Submitted' : status === 'submitting' ? 'Submitting...' : 'Submit for review'}
                </button>
              ) : null}
            </div>
          </form>
        </div>
      </main>
    </>
  );
}

function BrowseRegistry() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const fetchSkills = useCallback(async (query: string) => {
    setLoading(true);
    setRegistryError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      const res = await fetch(`${API_URL}/api/v1/skills?${params}`);
      if (!res.ok) {
        throw new Error(`Skills request failed with ${res.status}`);
      }

      const data = (await res.json()) as RegistrySkillsResponse;
      setSkills(Array.isArray(data.items) ? data.items.map(mapSkillSummary) : []);
    } catch {
      setSkills([]);
      setRegistryError('Registry API is unreachable. Check the API service and retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSkills(search);
    }, 300);

    return () => clearTimeout(timer);
  }, [search, fetchSkills]);

  const totalStars = skills.reduce((a, s) => a + s.stars, 0);

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <div className="logo">
            <img src="/logo.svg" alt="Skill Registry" />
          </div>

          <PrimaryNav current="browse" />
          <MockAuthBanner />

          <div className="search-wrapper">
            <div className="search-box">
              <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                placeholder="Search agent skills..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

        </div>
      </header>

      <main>
        <div className="container">
          <div className="hero">
            <h1>
              Agent <span className="highlight">Skill</span> Registry
            </h1>
            <p>
              Browse, search and install skills for AI coding agents.
              Works with Office Companion, Codex, Cursor and more.
            </p>
            <div className="stats">
              <div className="stat">
                <div className="stat-value">{skills.length}</div>
                <div className="stat-label">Skills</div>
              </div>
              <div className="stat">
                <div className="stat-value">{totalStars.toLocaleString()}</div>
                <div className="stat-label">Stars</div>
              </div>
            </div>
          </div>

          <div className={`source-indicator${registryError ? ' source-indicator-error' : ''}`}>
            <span className="dot" />
            <span>{registryError ? 'Registry unavailable' : 'Connected to Registry'}</span>
          </div>

          {loading ? (
            <div className="loading">
              <div className="spinner" />
            </div>
          ) : registryError ? (
            <div className="empty-state registry-error-state" role="alert" aria-live="assertive">
              <p>{registryError}</p>
              <button className="secondary-btn" type="button" onClick={() => fetchSkills(search)}>
                Retry
              </button>
            </div>
          ) : skills.length === 0 ? (
            <div className="empty-state">
              <p>No skills found. Try a different search term.</p>
            </div>
          ) : (
            <div className="skills-grid">
              {skills.map((skill) => (
                <a
                  key={skill.id}
                  className="skill-card"
                  href={getSkillPath(skill.owner, skill.name)}
                  aria-label={`Open ${skill.owner}/${skill.name} details`}
                >
                  <div className="skill-header">
                    <div>
                      <div className="skill-name">{skill.name}</div>
                      <div className="skill-repo">{skill.owner}</div>
                    </div>
                    {skill.version && (
                      <span className="skill-version">v{skill.version}</span>
                    )}
                  </div>
                  <div className="skill-description">
                    {skill.description || 'No description available'}
                  </div>
                  <div className="skill-footer">
                    <div className="skill-stat stars">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                      {skill.stars.toLocaleString()}
                    </div>
                    {skill.installs > 0 && (
                      <div className="skill-stat">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                        </svg>
                        {skill.installs}
                      </div>
                    )}
                    {skill.tags.length > 0 && (
                      <div className="skill-tags">
                        {skill.tags.slice(0, 2).map((tag) => (
                          <span key={tag} className="tag">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}

function SkillNotFoundState({
  title = 'Skill not found',
  message = 'The requested skill page does not exist in this registry. Return to browse and try another skill.',
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </a>
          <PrimaryNav current="browse" />
          <MockAuthBanner />
        </div>
      </header>

      <main className="not-found-main">
        <section className="not-found-state" aria-labelledby="not-found-title">
          <p className="eyebrow">Skill lookup</p>
          <h1 id="not-found-title">{title}</h1>
          <p>{message}</p>
          <div className="not-found-actions">
            <a className="primary-link" href="/">Browse skills</a>
            <button className="secondary-btn" type="button" onClick={onRetry ?? (() => window.location.reload())}>
              Retry
            </button>
          </div>
        </section>
      </main>
    </>
  );
}

function AccessDeniedState({
  current = 'review',
  title = 'Compliance role required',
  message = 'Approval review is available only to Compliance and Admin sessions.',
}: {
  current?: 'browse' | 'publish' | 'review';
  title?: string;
  message?: string;
}) {
  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </a>
          <PrimaryNav current={current} />
          <MockAuthBanner />
        </div>
      </header>

      <main className="not-found-main">
        <section className="not-found-state" aria-labelledby="access-denied-title">
          <p className="eyebrow">Access denied</p>
          <h1 id="access-denied-title">{title}</h1>
          <p>{message}</p>
          <div className="not-found-actions">
            <a className="primary-link" href="/">Browse skills</a>
          </div>
        </section>
      </main>
    </>
  );
}

function RequireReviewRole({ children }: { children: ReactNode }) {
  const session = useSession();
  if (!session.canReview) {
    return <AccessDeniedState />;
  }

  return <>{children}</>;
}

function RequireSubmitRole({ children }: { children: ReactNode }) {
  const session = useSession();
  if (!session.canSubmit) {
    return (
      <AccessDeniedState
        current="publish"
        title="Submitter role required"
        message="Skill publishing is available only to Submitter and Admin sessions."
      />
    );
  }

  return <>{children}</>;
}

function NotFoundState() {
  return (
    <SkillNotFoundState
      title="Route not found"
      message="The requested page is not available. Return to browse and try another registry path."
    />
  );
}

function SkillVersionDiffPage({ owner, name, version }: { owner: string; name: string; version: string }) {
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'not-found' | 'unavailable' | null>(null);

  const fetchDiff = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${API_URL}/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/diff`,
      );
      if (res.status === 404) {
        setDiff(null);
        setError('not-found');
        return;
      }
      if (!res.ok) {
        throw new Error(`Skill version diff request failed with ${res.status}`);
      }

      setDiff((await res.json()) as VersionDiff);
    } catch {
      setDiff(null);
      setError('unavailable');
    } finally {
      setLoading(false);
    }
  }, [name, owner, version]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  if (loading) {
    return (
      <>
        <div className="brand-stripe" />
        <header>
          <div className="container app-topbar">
            <a className="logo" href="/" aria-label="asr home">
              <img src="/logo.svg" alt="asr" />
            </a>
            <PrimaryNav current="browse" />
            <MockAuthBanner />
          </div>
        </header>
        <main>
          <div className="loading">
            <div className="spinner" />
          </div>
        </main>
      </>
    );
  }

  if (error === 'not-found') {
    return (
      <SkillNotFoundState
        title="Diff not found"
        message={`No version diff is available for ${owner}/${name} v${version}. Return to the skill detail page or retry the lookup.`}
        onRetry={fetchDiff}
      />
    );
  }

  if (error === 'unavailable' || !diff) {
    return (
      <SkillNotFoundState
        title="Diff unavailable"
        message={`Unable to load the version diff for ${owner}/${name} v${version} from the registry API.`}
        onRetry={fetchDiff}
      />
    );
  }

  const fileRows = [
    ['Added', diff.filesAdded],
    ['Modified', diff.filesModified],
    ['Removed', diff.filesRemoved],
  ] as const;
  const dependencyRows = [
    ['Added', Object.entries(diff.dependenciesAdded).map(([dep, depVersion]) => `${dep}@${depVersion}`)],
    ['Changed', Object.entries(diff.dependenciesChanged).map(([dep, change]) => `${dep}: ${change.from} -> ${change.to}`)],
    ['Removed', Object.entries(diff.dependenciesRemoved).map(([dep, depVersion]) => `${dep}@${depVersion}`)],
  ] as const;

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </a>
          <PrimaryNav current="browse" />
          <MockAuthBanner />
        </div>
      </header>

      <main className="skill-detail-main">
        <article className="container skill-detail-page">
          <a className="secondary-link" href={`/skills/${encodeRoutePart(owner)}/${encodeRoutePart(name)}`}>Back to skill</a>
          <div className="skill-detail-header">
            <p className="eyebrow">Version diff</p>
            <h1>{owner}/{name}</h1>
            <p>Changes from {diff.fromVersion || 'first publish'} to {diff.toVersion}.</p>
            <div className="skill-detail-meta">
              <span>{diff.riskAssessment} risk</span>
              <span>{diff.permissionsExpanded ? 'permissions expanded' : 'permissions unchanged'}</span>
              <span>{formatDate(diff.computedAt)}</span>
            </div>
          </div>

          <section className="version-diff-grid" aria-label="Version diff summary">
            <div className="version-diff-section">
              <h2>Files</h2>
              {fileRows.map(([label, files]) => (
                <div className="version-diff-row" key={label}>
                  <strong>{label}</strong>
                  <span>{files.length ? files.join(', ') : 'none'}</span>
                </div>
              ))}
            </div>

            <div className="version-diff-section">
              <h2>Dependencies</h2>
              {dependencyRows.map(([label, dependencies]) => (
                <div className="version-diff-row" key={label}>
                  <strong>{label}</strong>
                  <span>{dependencies.length ? dependencies.join(', ') : 'none'}</span>
                </div>
              ))}
            </div>

            <div className="version-diff-section">
              <h2>Manifest</h2>
              <div className="version-diff-row">
                <strong>Kind changed</strong>
                <span>{diff.manifestKindChanged ? 'yes' : 'no'}</span>
              </div>
              <div className="version-diff-row">
                <strong>Content hash</strong>
                <span>{diff.toContentHash}</span>
              </div>
            </div>
          </section>
        </article>
      </main>
    </>
  );
}

function SkillDetailPage({ owner, name }: { owner: string; name: string }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'not-found' | 'unavailable' | null>(null);
  const [activeTab, setActiveTab] = useState<SkillDetailTab>('preview');

  const fetchSkill = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
      if (res.status === 404) {
        setDetail(null);
        setError('not-found');
        return;
      }
      if (!res.ok) {
        throw new Error(`Skill detail request failed with ${res.status}`);
      }

      setDetail((await res.json()) as SkillDetail);
    } catch {
      setDetail(null);
      setError('unavailable');
    } finally {
      setLoading(false);
    }
  }, [name, owner]);

  useEffect(() => {
    fetchSkill();
  }, [fetchSkill]);

  if (loading) {
    return (
      <>
        <div className="brand-stripe" />
        <header>
          <div className="container app-topbar">
            <a className="logo" href="/" aria-label="asr home">
              <img src="/logo.svg" alt="asr" />
            </a>
            <PrimaryNav current="browse" />
            <MockAuthBanner />
          </div>
        </header>
        <main>
          <div className="loading">
            <div className="spinner" />
          </div>
        </main>
      </>
    );
  }

  if (error === 'not-found') {
    return (
      <SkillNotFoundState
        message={`No published skill exists for ${owner}/${name}. Return to browse or retry the lookup.`}
        onRetry={fetchSkill}
      />
    );
  }

  if (error === 'unavailable' || !detail) {
    return (
      <SkillNotFoundState
        title="Registry unavailable"
        message={`Unable to load ${owner}/${name} from the registry API.`}
        onRetry={fetchSkill}
      />
    );
  }

  const permissions = detail.manifestLatest.permissions;
  const permissionRows = [
    ['Network', permissions.network],
    ['Network hosts', permissions.networkHosts ?? []],
    ['Filesystem', permissions.filesystem],
    ['Subprocess', permissions.subprocess],
    ['Environment', permissions.environment],
  ] as const;
  const markdownPreview = detail.skillMd
    ? stripFrontmatter(detail.skillMd)
    : detail.manifestLatest.description || detail.description || 'No SKILL.md preview available.';

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </a>
          <PrimaryNav current="browse" />
          <MockAuthBanner />
        </div>
      </header>

      <main className="skill-detail-main">
        <article className="container skill-detail-page">
          <a className="secondary-link" href="/">Back to browse</a>
          <div className="skill-detail-header">
            <p className="eyebrow">{detail.owner}</p>
            <h1>{detail.name}</h1>
            <p>{detail.description || detail.manifestLatest.description || 'No description available'}</p>
            <div className="skill-detail-meta">
              <span>v{detail.latestVersion}</span>
              <span>{detail.downloadCount.toLocaleString()} downloads</span>
              <span>{detail.versions.length.toLocaleString()} versions</span>
            </div>
          </div>

          <div className="install-cmd">
            <code>{getInstallCommand(detail.owner, detail.name)}</code>
          </div>

          <div className="skill-detail-tabs" role="tablist" aria-label="Skill detail sections">
            {skillDetailTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? 'active' : undefined}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <section className="skill-detail-panel" role="tabpanel" aria-label={skillDetailTabs.find((tab) => tab.id === activeTab)?.label}>
            {activeTab === 'preview' && (
              <div className="skill-content">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a({ children, href }) {
                      return (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {markdownPreview}
                </ReactMarkdown>
              </div>
            )}

            {activeTab === 'versions' && (
              <div className="versions-list">
                {detail.versions.map((version) => (
                  <div
                    key={version.version}
                    className={`version-row${version.yanked ? ' yanked' : ''}`}
                    title={version.yanked ? version.yankReason ?? 'This version has been yanked.' : undefined}
                  >
                    <div>
                      <strong>v{version.version}</strong>
                      <span>{formatDate(version.publishedAt)}</span>
                    </div>
                    <div className="version-row-meta">
                      <span>{version.riskAssessment} risk</span>
                      {version.yanked && <span>Yanked</span>}
                      <a href={getSkillVersionDiffPath(detail.owner, detail.name, version.version)}>Diff</a>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'permissions' && (
              <dl className="permissions-list">
                {permissionRows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{formatPermissionValue(value)}</dd>
                  </div>
                ))}
              </dl>
            )}

            {activeTab === 'audit' && (
              <div className="audit-placeholder">
                <p>Audit events are available after signing in with a compliance or administrator role.</p>
              </div>
            )}
          </section>
        </article>
      </main>
    </>
  );
}

function AppRoutes() {
  const { pathname } = window.location;
  const routeParts = pathname.split('/').filter(Boolean).map(decodeRoutePart);

  if (pathname === '/' || pathname === '/skills') {
    return <BrowseRegistry />;
  }

  if (routeParts[0] === 'skills') {
    if (routeParts.length === 6 && routeParts[3] === 'versions' && routeParts[5] === 'diff') {
      return <SkillVersionDiffPage owner={routeParts[1]} name={routeParts[2]} version={routeParts[4]} />;
    }

    if (routeParts.length === 3) {
      return <SkillDetailPage owner={routeParts[1]} name={routeParts[2]} />;
    }

    return (
      <SkillNotFoundState
        message={`No published skill exists at /${routeParts.join('/')}. Return to browse or retry the lookup.`}
      />
    );
  }

  if (pathname === '/review') {
    return (
      <RequireReviewRole>
        <ReviewDashboard />
      </RequireReviewRole>
    );
  }

  if (routeParts[0] === 'review' && routeParts.length === 2) {
    return (
      <RequireReviewRole>
        <ReviewDetailPage submissionId={routeParts[1]} />
      </RequireReviewRole>
    );
  }

  if (pathname === '/publish' || pathname === '/submit') {
    return (
      <RequireSubmitRole>
        <PublishSkill />
      </RequireSubmitRole>
    );
  }

  return <NotFoundState />;
}

export default function App() {
  return (
    <SessionProvider>
      <AppRoutes />
    </SessionProvider>
  );
}
