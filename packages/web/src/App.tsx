import { useState, useEffect, useCallback, useRef } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { ReactDiffViewerProps } from 'react-diff-viewer-continued';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLocation } from 'react-router-dom';
import { parseSkillMd, type SkillDetail, type SkillSummary, type VersionDiff } from '@asr/core';
import { SessionProvider, type Session } from './auth/SessionProvider';
import { useSession } from './auth/useSession';
import { BrandLogo } from './branding/BrandLogo';
import { BrandToggle } from './branding/BrandToggle';
import { useBrand } from './branding/BrandProvider';

export { SessionProvider } from './auth/SessionProvider';

type BrowseKindFilter = 'all' | SkillSummary['kind'];
type BrowseRiskFilter = 'all' | SkillSummary['riskAssessmentLatest'];

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

interface Skill {
  id: string;
  owner: string;
  name: string;
  description: string;
  tags: string[];
  kind: SkillSummary['kind'];
  stars: number;
  installs: number;
  version?: string;
  riskAssessmentLatest: SkillSummary['riskAssessmentLatest'];
  content?: string;
  updated_at: string;
}

const API_URL = import.meta.env.VITE_API_URL || '';
const SUBMISSIONS_API_BASE = `${API_URL}/api/v1/submissions`;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_EMPTY_ARCHIVE_HEADER = 0x06054b50;
const ZIP_SPANNED_ARCHIVE_HEADER = 0x08074b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_EOCD_HEADER = 0x06054b50;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_EOCD_MAX_COMMENT_BYTES = 0xffff;
const ZIP_EOCD_ENTRY_COUNT_OFFSET = 10;
const ZIP_EOCD_DIRECTORY_SIZE_OFFSET = 12;
const ZIP_EOCD_DIRECTORY_OFFSET = 16;
const ZIP_CENTRAL_DIRECTORY_FIXED_BYTES = 46;
const ZIP_CENTRAL_DIRECTORY_NAME_LENGTH_OFFSET = 28;
const ZIP_CENTRAL_DIRECTORY_EXTRA_LENGTH_OFFSET = 30;
const ZIP_CENTRAL_DIRECTORY_COMMENT_LENGTH_OFFSET = 32;

interface RegistrySkillsResponse {
  items?: SkillSummary[];
}

type PublishStatus = 'idle' | 'submitting' | 'submitted';
type PublishWizardStep = 'upload' | 'manifest' | 'questionnaire' | 'review';
type SkillDetailTab = 'preview' | 'versions' | 'permissions' | 'audit';
type RegistryConnectionStatus = 'checking' | 'connected' | 'unavailable';

interface PublishFormErrors {
  skillArchive?: string;
  skillMd?: string;
  owner?: string;
}

interface PublishValidationSummaryItem {
  fieldId?: string;
  id: string;
  message: string;
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

function sessionCanReview(session: Session): boolean {
  return session.roles.some((role) => role === 'Compliance' || role === 'Admin');
}

function sessionCanSubmit(session: Session): boolean {
  return session.roles.some((role) => role === 'Submitter' || role === 'Admin');
}

function sessionRoleLabel(session: Session): string {
  return session.roles.length > 0 ? session.roles.join(', ') : 'Viewer';
}

function mapSkillSummary(skill: SkillSummary): Skill {
  return {
    id: `${skill.owner}/${skill.name}`,
    owner: skill.owner,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    kind: skill.kind,
    stars: 0,
    installs: skill.downloadCount,
    version: skill.latestVersion,
    riskAssessmentLatest: skill.riskAssessmentLatest,
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

function getSkillDetailTabId(tab: SkillDetailTab): string {
  return `skill-detail-tab-${tab}`;
}

function getSkillDetailPanelId(tab: SkillDetailTab): string {
  return `skill-detail-panel-${tab}`;
}

export const reviewDiffViewerStyles = {
  diffContainer: {
    maxWidth: '100%',
    minWidth: 0,
    tableLayout: 'fixed',
    width: '100%',
    pre: {
      maxWidth: '100%',
      overflowWrap: 'anywhere',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    },
  },
  content: {
    maxWidth: '100%',
    minWidth: 0,
    overflow: 'visible',
    width: '50%',
  },
  contentText: {
    display: 'block',
    maxWidth: '100%',
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  lineContent: {
    overflow: 'visible',
  },
} satisfies NonNullable<ReactDiffViewerProps['styles']>;

export const mobileReviewDiffViewerStyles = {
  ...reviewDiffViewerStyles,
  diffContainer: {
    ...reviewDiffViewerStyles.diffContainer,
    minWidth: 0,
    tableLayout: 'fixed',
    width: '100%',
  },
  content: {
    ...reviewDiffViewerStyles.content,
    width: '100%',
  },
  contentText: {
    ...reviewDiffViewerStyles.contentText,
    whiteSpace: 'pre-wrap',
  },
  wordDiff: {
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
} satisfies NonNullable<ReactDiffViewerProps['styles']>;

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

function PrimaryNav({ current }: { current: 'browse' | 'publish' | 'review' }) {
  const session = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const roleLabel = sessionRoleLabel(session);

  useEffect(() => {
    setMobileOpen(false);
  }, [current]);

  return (
    <>
      <nav className="primary-nav" aria-label="Primary navigation">
        <a href="/" aria-current={current === 'browse' ? 'page' : undefined}>Browse</a>
        <a href="/publish" aria-current={current === 'publish' ? 'page' : undefined}>Publish</a>
        {sessionCanReview(session) ? (
          <a href="/review" aria-current={current === 'review' ? 'page' : undefined}>Review</a>
        ) : null}
      </nav>

      <button
        type="button"
        className="mobile-nav-toggle"
        aria-label={mobileOpen ? 'Close primary navigation' : 'Open primary navigation'}
        aria-expanded={mobileOpen}
        aria-controls="mobile-primary-nav"
        onClick={() => setMobileOpen((open) => !open)}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>

      {mobileOpen ? (
        <div className="mobile-nav-backdrop" onClick={() => setMobileOpen(false)}>
          <aside
            id="mobile-primary-nav"
            className="mobile-nav-panel"
            aria-label="Mobile primary navigation"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-nav-header">
              <BrandLogo />
              <button
                type="button"
                className="mobile-nav-close"
                aria-label="Close primary navigation"
                onClick={() => setMobileOpen(false)}
              >
                <span aria-hidden="true" />
                <span aria-hidden="true" />
              </button>
            </div>
            <nav className="mobile-nav-links" aria-label="Mobile navigation links">
              <a href="/" aria-current={current === 'browse' ? 'page' : undefined}>Browse</a>
              <a href="/publish" aria-current={current === 'publish' ? 'page' : undefined}>Publish</a>
              {sessionCanReview(session) ? (
                <a href="/review" aria-current={current === 'review' ? 'page' : undefined}>Review</a>
              ) : null}
            </nav>
            {import.meta.env.DEV ? (
              <div className="mobile-session-summary" aria-label={`${session.authMode === 'mock' ? 'Development mock auth' : 'Signed in'} session for ${session.sub} with ${roleLabel} role`}>
                <span>{session.authMode === 'mock' ? 'Dev mock auth' : 'Signed in'}</span>
                <strong>{session.sub}</strong>
                <small>{roleLabel}</small>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </>
  );
}

function MockAuthBanner() {
  if (!import.meta.env.DEV) {
    return null;
  }

  const session = useSession();
  const roleLabel = sessionRoleLabel(session);
  const label = session.authMode === 'mock' ? 'Dev mock auth' : 'Signed in';
  return (
    <div
      className="mock-auth-banner"
      role="status"
      aria-label={`${session.authMode === 'mock' ? 'Development mock auth' : 'Signed in'} session for ${session.sub} with ${roleLabel} role`}
    >
      <span className="mock-auth-label">{label}</span>
      <span className="mock-auth-identity">{session.sub}</span>
      <span className="mock-auth-role">{roleLabel}</span>
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

  const header = new DataView(await readBlobSlice(file, 0, 4)).getUint32(0, true);
  if (![ZIP_LOCAL_FILE_HEADER, ZIP_EMPTY_ARCHIVE_HEADER, ZIP_SPANNED_ARCHIVE_HEADER].includes(header)) {
    return 'Archive file is not a valid zip archive.';
  }

  const tailLength = Math.min(file.size, ZIP_EOCD_MIN_BYTES + ZIP_EOCD_MAX_COMMENT_BYTES);
  const tailOffset = file.size - tailLength;
  const tail = new DataView(await readBlobSlice(file, tailOffset));
  for (let offset = tail.byteLength - ZIP_EOCD_MIN_BYTES; offset >= 0; offset -= 1) {
    if (tail.getUint32(offset, true) === ZIP_EOCD_HEADER) {
      const entryCount = tail.getUint16(offset + ZIP_EOCD_ENTRY_COUNT_OFFSET, true);
      const directorySize = tail.getUint32(offset + ZIP_EOCD_DIRECTORY_SIZE_OFFSET, true);
      const directoryOffset = tail.getUint32(offset + ZIP_EOCD_DIRECTORY_OFFSET, true);

      if (entryCount === 0 || directorySize === 0 || directoryOffset + directorySize > file.size) {
        return 'Archive file is not a valid zip archive.';
      }

      return validateZipPackageEntries(
        await readBlobSlice(file, directoryOffset, directoryOffset + directorySize),
        entryCount,
      );
    }
  }

  return 'Archive file is not a valid zip archive.';
}

async function readBlobSlice(file: File, start: number, end?: number): Promise<ArrayBuffer> {
  const blob = file.slice(start, end);
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read archive bytes.'));
      }
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Unable to read archive bytes.')));
    reader.readAsArrayBuffer(blob);
  });
}

function validateZipPackageEntries(directoryBuffer: ArrayBuffer, entryCount: number): string | undefined {
  const directory = new DataView(directoryBuffer);
  const decoder = new TextDecoder();
  const entries: string[] = [];
  let offset = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + ZIP_CENTRAL_DIRECTORY_FIXED_BYTES > directory.byteLength) {
      return 'Archive file is not a valid zip archive.';
    }

    if (directory.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      return 'Archive file is not a valid zip archive.';
    }

    const nameLength = directory.getUint16(offset + ZIP_CENTRAL_DIRECTORY_NAME_LENGTH_OFFSET, true);
    const extraLength = directory.getUint16(offset + ZIP_CENTRAL_DIRECTORY_EXTRA_LENGTH_OFFSET, true);
    const commentLength = directory.getUint16(offset + ZIP_CENTRAL_DIRECTORY_COMMENT_LENGTH_OFFSET, true);
    const nameStart = offset + ZIP_CENTRAL_DIRECTORY_FIXED_BYTES;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > directory.byteLength) {
      return 'Archive file is not a valid zip archive.';
    }

    entries.push(decoder.decode(new Uint8Array(directoryBuffer, nameStart, nameLength)));
    offset = nameEnd + extraLength + commentLength;
  }

  const paths = entries
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((entry) => entry && !entry.endsWith('/'));
  const rootNames = new Set(paths.map((entry) => entry.split('/')[0]).filter(Boolean));

  if (paths.length === 0 || rootNames.size !== 1 || paths.some((entry) => entry.split('/').length < 2)) {
    return 'Archive must contain a single root directory.';
  }

  const [rootName] = [...rootNames];
  if (!paths.includes(`${rootName}/manifest.yaml`)) {
    return 'Archive must include manifest.yaml in the root directory.';
  }

  if (!paths.includes(`${rootName}/SKILL.md`)) {
    return 'Archive must include SKILL.md in the root directory.';
  }

  return undefined;
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

function PublishSkill() {
  const session = useSession();
  const archiveSelectionId = useRef(0);
  const validationSummaryRef = useRef<HTMLDivElement>(null);
  const [owner, setOwner] = useState('');
  const [skillMd, setSkillMd] = useState('');
  const [skillArchive, setSkillArchive] = useState<File | null>(null);
  const [currentStep, setCurrentStep] = useState<PublishWizardStep>('upload');
  const [highestUnlockedStep, setHighestUnlockedStep] = useState<PublishWizardStep>('upload');
  const [manifestDraft, setManifestDraft] = useState<PublishManifestDraft>(emptyManifestDraft);
  const [questionnaire, setQuestionnaire] = useState<QuestionnaireDraft>(emptyQuestionnaireDraft);
  const [errors, setErrors] = useState<PublishFormErrors>({});
  const [validationSummary, setValidationSummary] = useState<PublishValidationSummaryItem[]>([]);
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
  const archiveSize = skillArchive ? `${(skillArchive.size / 1024 / 1024).toFixed(2)} MB` : null;
  const manifestTags = manifestDraft.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const highestUnlockedStepIndex = publishWizardSteps.findIndex((item) => item.id === highestUnlockedStep);

  function getWizardStepIndex(step: PublishWizardStep) {
    return publishWizardSteps.findIndex((item) => item.id === step);
  }

  function unlockStep(step: PublishWizardStep) {
    const stepIndex = getWizardStepIndex(step);
    if (stepIndex > highestUnlockedStepIndex) {
      setHighestUnlockedStep(step);
    }
  }

  useEffect(() => {
    if (validationSummary.length > 0) {
      validationSummaryRef.current?.focus();
    }
  }, [validationSummary]);

  function summarizeUploadErrors(nextErrors: PublishFormErrors): PublishValidationSummaryItem[] {
    const items: Array<PublishValidationSummaryItem | null> = [
      nextErrors.owner
        ? { id: 'owner', fieldId: 'publish-owner', message: nextErrors.owner }
        : null,
      nextErrors.skillArchive
        ? { id: 'skillArchive', fieldId: 'publish-archive', message: nextErrors.skillArchive }
        : null,
      nextErrors.skillMd
        ? { id: 'skillMd', fieldId: 'publish-skill-md', message: nextErrors.skillMd }
        : null,
    ];

    return items.filter((item): item is PublishValidationSummaryItem => Boolean(item));
  }

  function getUploadErrors() {
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

    return nextErrors;
  }

  function validateUploadStep() {
    const nextErrors = getUploadErrors();
    setErrors(nextErrors);
    const nextSummary = summarizeUploadErrors(nextErrors);
    setValidationSummary(nextSummary);
    return nextSummary.length === 0;
  }

  function getManifestValidationSummary(): PublishValidationSummaryItem[] {
    const items: Array<PublishValidationSummaryItem | null> = [
      manifestDraft.name.trim()
        ? null
        : { id: 'manifest-name', fieldId: 'publish-skill-md', message: 'SKILL.md frontmatter must include a name.' },
      manifestDraft.version.trim()
        ? null
        : { id: 'manifest-version', fieldId: 'publish-skill-md', message: 'SKILL.md frontmatter must include a version.' },
      manifestDraft.author.trim()
        ? null
        : { id: 'manifest-author', fieldId: 'publish-skill-md', message: 'SKILL.md frontmatter must include an author.' },
      manifestDraft.description.trim()
        ? null
        : { id: 'manifest-description', fieldId: 'publish-skill-md', message: 'SKILL.md frontmatter must include a description.' },
    ];

    return items.filter((item): item is PublishValidationSummaryItem => Boolean(item));
  }

  function validateManifestStep() {
    const nextSummary = getManifestValidationSummary();
    setValidationSummary(nextSummary);
    return nextSummary.length === 0;
  }

  function getQuestionnaireValidationSummary(): PublishValidationSummaryItem[] {
    const items: Array<PublishValidationSummaryItem | null> = [
      questionnaire.externalNetwork
        ? null
        : {
          id: 'externalNetwork',
          fieldId: 'publish-external-network-group',
          message: 'Select whether this skill requires external network access.',
        },
      questionnaire.filesystemAccess
        ? null
        : {
          id: 'filesystemAccess',
          fieldId: 'publish-filesystem-access',
          message: 'Select a filesystem access level.',
        },
    ];

    return items.filter((item): item is PublishValidationSummaryItem => Boolean(item));
  }

  function validateQuestionnaireStep() {
    const nextSummary = getQuestionnaireValidationSummary();
    setValidationSummary(nextSummary);
    return nextSummary.length === 0;
  }

  function goToStep(step: PublishWizardStep) {
    if (canOpenStep(step)) {
      setCurrentStep(step);
    }
  }

  function canOpenStep(step: PublishWizardStep) {
    if (getWizardStepIndex(step) > highestUnlockedStepIndex) {
      return false;
    }

    switch (step) {
      case 'upload':
        return true;
      case 'manifest':
        return uploadIsValid;
      case 'questionnaire':
        return uploadIsValid && manifestIsValid;
      case 'review':
        return uploadIsValid && manifestIsValid && questionnaireIsValid;
    }
  }

  function continueFromUpload() {
    setSubmitMessage(null);
    if (!validateUploadStep()) {
      return;
    }

    setManifestDraft(createManifestDraft(skillMd));
    unlockStep('manifest');
    setCurrentStep('manifest');
  }

  function continueFromManifest() {
    if (!validateManifestStep()) {
      return;
    }

    unlockStep('questionnaire');
    setCurrentStep('questionnaire');
  }

  function continueFromQuestionnaire() {
    if (!validateQuestionnaireStep()) {
      return;
    }

    unlockStep('review');
    setCurrentStep('review');
  }

  function updateSkillMd(content: string) {
    setSkillMd(content);
    setManifestDraft(createManifestDraft(content));
    setErrors((current) => {
      const next = { ...current };
      const skillMdError = content.trim() ? validateSkillMd(content) : undefined;
      if (skillMdError) {
        next.skillMd = skillMdError;
      } else {
        delete next.skillMd;
      }
      return next;
    });
  }

  async function submitSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitMessage(null);

    if (status !== 'idle') {
      return;
    }

    if (!sessionCanSubmit(session)) {
      setSubmitMessage('Submitter role required to publish skills.');
      setValidationSummary([{ id: 'session-role', message: 'Submitter role required to publish skills.' }]);
      return;
    }

    const uploadStepIsValid = validateUploadStep();
    const manifestStepIsValid = validateManifestStep();
    const questionnaireStepIsValid = validateQuestionnaireStep();
    if (!uploadStepIsValid || !skillArchive || !manifestStepIsValid || !questionnaireStepIsValid) {
      if (!uploadStepIsValid || !skillArchive) {
        setCurrentStep('upload');
        setValidationSummary(summarizeUploadErrors(getUploadErrors()));
      } else if (!manifestStepIsValid) {
        setCurrentStep('manifest');
        setValidationSummary(getManifestValidationSummary());
      } else if (!questionnaireStepIsValid) {
        setCurrentStep('questionnaire');
        setValidationSummary(getQuestionnaireValidationSummary());
      }
      return;
    }

    setStatus('submitting');
    try {
      const body = new FormData();
      body.set('owner', owner.trim());
      body.set('skillMd', skillMd);
      body.set('archive', skillArchive);

      const res = await fetch(SUBMISSIONS_API_BASE, {
        method: 'POST',
        body,
      });

      if (!res.ok) {
        throw new Error(`Submission request failed with ${res.status}`);
      }

      setSubmitMessage('Submission created and queued for scanning.');
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
      setValidationSummary([
        { id: 'skillArchive', fieldId: 'publish-archive', message: archiveError },
      ]);
      input.value = '';
      return;
    }

    setSkillArchive(file);
    setErrors((current) => {
      const next = { ...current };
      delete next.skillArchive;
      return next;
    });
    setValidationSummary((current) => current.filter((item) => item.id !== 'skillArchive'));
  }

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <BrandLogo />
          </a>
          <PrimaryNav current="publish" />
          <div className="app-topbar-right"><BrandToggle /><MockAuthBanner /></div>
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
                      disabled={!canOpenStep(step.id)}
                    >
                      <span>{index + 1}</span>
                      {step.label}
                    </button>
                  </li>
                );
              })}
            </ol>

            {validationSummary.length > 0 ? (
              <div
                ref={validationSummaryRef}
                className="publish-validation-summary"
                role="alert"
                aria-live="assertive"
                tabIndex={-1}
              >
                <strong>Complete these fields before continuing:</strong>
                <ul>
                  {validationSummary.map((item) => (
                    <li key={item.id}>
                      {item.fieldId ? <a href={`#${item.fieldId}`}>{item.message}</a> : item.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {currentStep === 'upload' ? (
              <section className="wizard-panel" aria-labelledby="publish-upload-title">
                <div className="wizard-panel-header">
                  <p className="eyebrow">Step 1</p>
                  <h2 id="publish-upload-title">Upload archive</h2>
                </div>
                <label className="field" htmlFor="publish-owner">
                  <span>
                    Registry owner
                    <span className="field-required" aria-hidden="true">*</span>
                    <span className="visually-hidden"> (required)</span>
                  </span>
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
                    required
                    aria-required="true"
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
                  <span>
                    Skill archive
                    <span className="field-required" aria-hidden="true">*</span>
                    <span className="visually-hidden"> (required)</span>
                  </span>
                  <strong>{skillArchive ? skillArchive.name : 'Drop zip archive here'}</strong>
                  <em>{archiveSize ? `${archiveSize} selected` : 'Zip archive, 50 MB maximum.'}</em>
                  <input
                    id="publish-archive"
                    type="file"
                    accept=".zip,application/zip"
                    required
                    aria-required="true"
                    onChange={(event) => void selectArchive(event.target.files?.[0] ?? null, event.currentTarget)}
                    aria-invalid={Boolean(errors.skillArchive)}
                    aria-describedby={errors.skillArchive ? 'publish-archive-error' : undefined}
                  />
                  {errors.skillArchive ? (
                    <small id="publish-archive-error" role="status">{errors.skillArchive}</small>
                  ) : null}
                </label>

                <label className="field" htmlFor="publish-skill-md">
                  <span>
                    SKILL.md
                    <span className="field-required" aria-hidden="true">*</span>
                    <span className="visually-hidden"> (required)</span>
                  </span>
                  <textarea
                    id="publish-skill-md"
                    value={skillMd}
                    onChange={(event) => updateSkillMd(event.target.value)}
                    rows={10}
                    placeholder={'---\nname: secure-code-review\nversion: 1.0.0\nauthor: Platform Team\ndescription: Review code for security issues.\ntags: [security, review]\n---\n\nUse this skill when...'}
                    required
                    aria-required="true"
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
                <fieldset className="question-group" id="publish-external-network-group">
                  <legend>Does this skill require external network access?</legend>
                  <label>
                    <input
                      id="publish-external-network-yes"
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
                      id="publish-external-network-no"
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
                  onClick={continueFromManifest}
                >
                  Continue
                </button>
              ) : null}
              {currentStep === 'questionnaire' ? (
                <button
                  className="submit-btn"
                  type="button"
                  onClick={continueFromQuestionnaire}
                >
                  Continue
                </button>
              ) : null}
              {currentStep === 'review' ? (
                <button className="submit-btn" type="submit" disabled={status !== 'idle'}>
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

function BrowseLoadingSkeleton() {
  return (
    <div className="browse-loading-skeleton" role="status" aria-live="polite" aria-label="Loading skills">
      <div className="skeleton-filter-row" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} className="skeleton-chip" />
        ))}
      </div>
      <div className="skills-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="skill-card skill-card-skeleton">
            <div className="skill-header">
              <div className="skeleton-stack">
                <span className="skeleton-line skeleton-line-title" />
                <span className="skeleton-line skeleton-line-short" />
              </div>
              <span className="skeleton-version" />
            </div>
            <div className="skeleton-copy">
              <span className="skeleton-line" />
              <span className="skeleton-line skeleton-line-medium" />
            </div>
            <div className="skill-footer">
              <span className="skeleton-line skeleton-line-stat" />
              <span className="skeleton-line skeleton-line-stat" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BrowseRegistry() {
  const { mode: brandMode } = useBrand();
  const heroTitle = brandMode === 'pwc' ? 'Agent Skill Repository' : 'asr';
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [registryStatus, setRegistryStatus] = useState<RegistryConnectionStatus>('checking');
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<BrowseKindFilter>('all');
  const [activeRisk, setActiveRisk] = useState<BrowseRiskFilter>('all');
  const latestFetchId = useRef(0);

  const fetchSkills = useCallback(async (query: string) => {
    const fetchId = latestFetchId.current + 1;
    latestFetchId.current = fetchId;
    setLoading(true);
    setRegistryStatus('checking');
    setRegistryError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      const res = await fetch(`${API_URL}/api/v1/skills?${params}`);
      if (!res.ok) {
        throw new Error(`Skills request failed with ${res.status}`);
      }

      const data = (await res.json()) as RegistrySkillsResponse;
      if (fetchId !== latestFetchId.current) {
        return;
      }
      setSkills(Array.isArray(data.items) ? data.items.map(mapSkillSummary) : []);
      setRegistryStatus('connected');
    } catch {
      if (fetchId !== latestFetchId.current) {
        return;
      }
      setSkills([]);
      setRegistryStatus('unavailable');
      setRegistryError('Registry API is unreachable. Check the API service and retry.');
    } finally {
      if (fetchId === latestFetchId.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSkills(search);
    }, 300);

    return () => clearTimeout(timer);
  }, [search, fetchSkills]);

  const availableTags = Array.from(new Set(skills.flatMap((skill) => skill.tags))).sort((a, b) => a.localeCompare(b));
  const availableKinds = Array.from(new Set(skills.map((skill) => skill.kind))).sort((a, b) => a.localeCompare(b));
  const availableRisks = Array.from(new Set(skills.map((skill) => skill.riskAssessmentLatest))).sort((a, b) => {
    const order: Record<SkillSummary['riskAssessmentLatest'], number> = { low: 0, medium: 1, high: 2 };
    return order[a] - order[b];
  });
  const normalizedSearch = search.trim().toLowerCase();
  const filteredSkills = skills.filter((skill) => {
    const matchesSearch = normalizedSearch === ''
      || [skill.owner, skill.name, skill.description, ...skill.tags]
        .some((value) => value.toLowerCase().includes(normalizedSearch));

    return (
      matchesSearch
      && (activeTag === null || skill.tags.includes(activeTag))
      && (activeKind === 'all' || skill.kind === activeKind)
      && (activeRisk === 'all' || skill.riskAssessmentLatest === activeRisk)
    );
  });
  const totalStars = filteredSkills.reduce((a, s) => a + s.stars, 0);

  const hasActiveFilters =
    normalizedSearch !== '' || activeTag !== null || activeKind !== 'all' || activeRisk !== 'all';

  function clearSearchAndFilters() {
    setSearch('');
    setActiveTag(null);
    setActiveKind('all');
    setActiveRisk('all');
  }

  function applyTagFilter(tag: string) {
    setActiveTag((currentTag) => currentTag === tag ? null : tag);
  }

  function handleCardTagClick(tag: string) {
    applyTagFilter(tag);
  }

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <div className="logo">
            <BrandLogo />
          </div>

          <PrimaryNav current="browse" />
          <div className="app-topbar-right"><BrandToggle /><MockAuthBanner /></div>

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
            <h1>{heroTitle}</h1>
            <p>
              Browse, search and install skills for AI coding agents.
              Works with Claude Code, Copilot, and other AI agents.
            </p>
            <div className="stats">
              <div className="stat">
                <div className="stat-value">{filteredSkills.length}</div>
                <div className="stat-label">Skills</div>
              </div>
              <div className="stat">
                <div className="stat-value">{totalStars.toLocaleString()}</div>
                <div className="stat-label">Stars</div>
              </div>
            </div>
          </div>

          <div className={`source-indicator source-indicator-${registryStatus}`}>
            <span className="dot" />
            <span>
              {registryStatus === 'connected'
                ? 'Connected to Registry'
                : registryStatus === 'unavailable'
                  ? 'Registry unavailable'
                  : 'Checking Registry'}
            </span>
          </div>

          {(availableTags.length > 0 || availableKinds.length > 0 || availableRisks.length > 0 || activeTag !== null || activeKind !== 'all' || activeRisk !== 'all') && !registryError && (
            <div className="browse-filter-panel" aria-label="Browse skill filters">
              {(availableTags.length > 0 || activeTag !== null) && (
                <div className="tag-filter-bar" role="group" aria-label="Filter skills by tag">
                  <span className="filter-label">Tag</span>
                  <button
                    className={`filter-chip${activeTag === null ? ' filter-chip-active' : ''}`}
                    type="button"
                    aria-pressed={activeTag === null}
                    onClick={() => setActiveTag(null)}
                  >
                    All
                  </button>
                  {availableTags.map((tag) => (
                    <button
                      key={tag}
                      className={`filter-chip${activeTag === tag ? ' filter-chip-active' : ''}`}
                      type="button"
                      aria-pressed={activeTag === tag}
                      onClick={() => applyTagFilter(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
              {(availableKinds.length > 0 || activeKind !== 'all') && (
                <div className="tag-filter-bar" role="group" aria-label="Filter skills by kind">
                  <span className="filter-label">Kind</span>
                  <button
                    className={`filter-chip${activeKind === 'all' ? ' filter-chip-active' : ''}`}
                    type="button"
                    aria-pressed={activeKind === 'all'}
                    onClick={() => setActiveKind('all')}
                  >
                    All
                  </button>
                  {availableKinds.map((kind) => (
                    <button
                      key={kind}
                      className={`filter-chip${activeKind === kind ? ' filter-chip-active' : ''}`}
                      type="button"
                      aria-pressed={activeKind === kind}
                      onClick={() => setActiveKind((currentKind) => currentKind === kind ? 'all' : kind)}
                    >
                      {kind}
                    </button>
                  ))}
                </div>
              )}
              {(availableRisks.length > 0 || activeRisk !== 'all') && (
                <div className="tag-filter-bar" role="group" aria-label="Filter skills by risk">
                  <span className="filter-label">Risk</span>
                  <button
                    className={`filter-chip${activeRisk === 'all' ? ' filter-chip-active' : ''}`}
                    type="button"
                    aria-pressed={activeRisk === 'all'}
                    onClick={() => setActiveRisk('all')}
                  >
                    All
                  </button>
                  {availableRisks.map((risk) => (
                    <button
                      key={risk}
                      className={`filter-chip${activeRisk === risk ? ' filter-chip-active' : ''}`}
                      type="button"
                      aria-pressed={activeRisk === risk}
                      onClick={() => setActiveRisk((currentRisk) => currentRisk === risk ? 'all' : risk)}
                    >
                      {risk} risk
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {loading ? (
            <BrowseLoadingSkeleton />
          ) : registryError ? (
            <div className="empty-state registry-error-state" role="alert" aria-live="assertive">
              <p>{registryError}</p>
              <button className="secondary-btn" type="button" onClick={() => fetchSkills(search)}>
                Retry
              </button>
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="empty-state">
              <p>
                {hasActiveFilters
                  ? 'No skills match your search.'
                  : 'No skills are available yet.'}
              </p>
              {hasActiveFilters ? (
                <button
                  className="secondary-btn"
                  type="button"
                  onClick={clearSearchAndFilters}
                >
                  Clear search and filters
                </button>
              ) : null}
            </div>
          ) : (
            <div className="skills-grid">
              {filteredSkills.map((skill) => (
                <article
                  key={skill.id}
                  className="skill-card"
                >
                  <a
                    className="skill-card-link"
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
                    <div className="skill-card-badges" aria-label="Skill metadata">
                      <span className="skill-kind-badge">{skill.kind}</span>
                      <span className={`risk-pill risk-${skill.riskAssessmentLatest}`}>
                        {skill.riskAssessmentLatest} risk
                      </span>
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
                    </div>
                  </a>
                  {skill.tags.length > 0 && (
                    <div className="skill-tags" aria-label={`${skill.owner}/${skill.name} tags`}>
                      {skill.tags.slice(0, 2).map((tag) => (
                        <button
                          key={tag}
                          className={`tag tag-action${activeTag === tag ? ' tag-active' : ''}`}
                          type="button"
                          aria-pressed={activeTag === tag}
                          onClick={() => handleCardTagClick(tag)}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
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
            <BrandLogo />
          </a>
          <PrimaryNav current="browse" />
          <div className="app-topbar-right"><BrandToggle /><MockAuthBanner /></div>
        </div>
      </header>

      <main className="not-found-main">
        <section className="not-found-state" role="alert" aria-live="assertive" aria-labelledby="not-found-title">
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
            <BrandLogo />
          </a>
          <PrimaryNav current={current} />
          <div className="app-topbar-right"><BrandToggle /><MockAuthBanner /></div>
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

function RequireSubmitRole({ children }: { children: ReactNode }) {
  const session = useSession();
  if (!sessionCanSubmit(session)) {
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
              <BrandLogo />
            </a>
            <PrimaryNav current="browse" />
            <div className="app-topbar-right"><BrandToggle /><MockAuthBanner /></div>
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
            <BrandLogo />
          </a>
          <PrimaryNav current="browse" />
          <div className="app-topbar-right"><BrandToggle /><MockAuthBanner /></div>
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
              <BrandLogo />
            </a>
            <PrimaryNav current="browse" />
            <div className="app-topbar-right"><BrandToggle /><MockAuthBanner /></div>
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
  const activeTabLabel = skillDetailTabs.find((tab) => tab.id === activeTab)?.label;
  const activeTabId = getSkillDetailTabId(activeTab);
  const activePanelId = getSkillDetailPanelId(activeTab);

  function focusSkillDetailTab(tab: SkillDetailTab) {
    document.getElementById(getSkillDetailTabId(tab))?.focus();
  }

  function handleSkillDetailTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();

    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (index + direction + skillDetailTabs.length) % skillDetailTabs.length;
    const nextTab = skillDetailTabs[nextIndex].id;
    setActiveTab(nextTab);
    focusSkillDetailTab(nextTab);
  }

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <BrandLogo />
          </a>
          <PrimaryNav current="browse" />
          <div className="app-topbar-right"><BrandToggle /><MockAuthBanner /></div>
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
            {skillDetailTabs.map((tab, index) => (
              <button
                key={tab.id}
                id={getSkillDetailTabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={getSkillDetailPanelId(tab.id)}
                className={activeTab === tab.id ? 'active' : undefined}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleSkillDetailTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <section
            id={activePanelId}
            className="skill-detail-panel"
            role="tabpanel"
            aria-label={activeTabLabel}
            aria-labelledby={activeTabId}
          >
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
  const { pathname } = useLocation();
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
