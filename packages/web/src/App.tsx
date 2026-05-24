import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

interface Skill {
  id: string;
  owner: string;
  repo: string;
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

const API_URL = import.meta.env.VITE_API_URL || '';

type Decision = 'approved' | 'rejected';

function getDecisionRequest(decision: Decision): { endpoint: 'approve' | 'reject'; body: { comment?: string; reason?: string } } {
  if (decision === 'approved') {
    return { endpoint: 'approve', body: {} };
  }

  return { endpoint: 'reject', body: { reason: 'Rejected from approval dashboard.' } };
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

function formatSubmittedAt(value: string): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function ReviewDashboard() {
  const [submissions, setSubmissions] = useState<ReviewSubmission[]>(mockReviewQueue);
  const [loading, setLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [decisionPending, setDecisionPending] = useState<Record<string, Decision>>({});
  const [decisionError, setDecisionError] = useState<Record<string, string>>({});

  const fetchQueue = useCallback(async () => {
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
      setQueueError('Unable to load pending submissions from the API.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  async function decideSubmission(id: string, decision: Decision) {
    setDecisionPending((current) => ({ ...current, [id]: decision }));
    setDecisionError((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });

    try {
      if (API_URL) {
        const { endpoint, body } = getDecisionRequest(decision);
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

  const pendingCount = submissions.filter((submission) => submission.status === 'pending review').length;
  const findingCount = submissions.reduce((total, submission) => total + submission.findings, 0);

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container review-topbar">
          <a className="logo" href="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </a>
          <nav className="review-nav" aria-label="Primary navigation">
            <a href="/">Browse</a>
            <a href="/review" aria-current="page">Review</a>
          </nav>
          <div className="mock-auth-banner">Mock auth: Compliance</div>
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
                <p>{loading ? 'Refreshing queue...' : `${submissions.length} submissions need compliance review`}</p>
              </div>
              <button className="secondary-btn" type="button" onClick={fetchQueue} disabled={loading}>
                Refresh
              </button>
            </div>

            {queueError ? <div className="queue-error" role="status">{queueError}</div> : null}

            <div className="submission-list">
              {submissions.map((submission) => {
                const pendingDecision = decisionPending[submission.id];
                const isReviewable = submission.status === 'pending review';
                const disableActions = Boolean(pendingDecision) || !isReviewable;

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
                      <button
                        className="approve-btn"
                        type="button"
                        onClick={() => decideSubmission(submission.id, 'approved')}
                        disabled={disableActions}
                      >
                        {pendingDecision === 'approved'
                          ? 'Approving...'
                          : submission.status === 'approved'
                            ? 'Approved'
                            : 'Approve'}
                      </button>
                      <button
                        className="reject-btn"
                        type="button"
                        onClick={() => decideSubmission(submission.id, 'rejected')}
                        disabled={disableActions}
                      >
                        {pendingDecision === 'rejected'
                          ? 'Rejecting...'
                          : submission.status === 'rejected'
                            ? 'Rejected'
                            : 'Reject'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

function BrowseRegistry() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Skill | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchSkills = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      const res = await fetch(`${API_URL}/api/skills?${params}`);
      const data = await res.json();
      setSkills(data.skills || []);
    } catch {
      setSkills([]);
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

  async function openSkill(skill: Skill) {
    setSelected(skill);

    if (!skill.content) {
      try {
        const res = await fetch(`${API_URL}/api/skills/${skill.owner}/${skill.repo}/${skill.name}`);
        if (res.ok) {
          const data = await res.json();
          setSelected({ ...skill, content: data.content || skill.description });
        } else {
          setSelected({ ...skill, content: skill.description });
        }
      } catch {
        setSelected({ ...skill, content: skill.description });
      }
    }
  }

  function copyInstallCmd() {
    if (!selected) return;
    const cmd = `asr add ${selected.owner}/${selected.repo}/${selected.name}`;
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const totalStars = skills.reduce((a, s) => a + s.stars, 0);

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container">
          <div className="logo">
            <img src="/logo.svg" alt="Skill Registry" />
          </div>

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

          <div className="source-indicator">
            <span className="dot" />
            <span>Connected to Registry</span>
          </div>

          {loading ? (
            <div className="loading">
              <div className="spinner" />
            </div>
          ) : skills.length === 0 ? (
            <div className="empty-state">
              <p>No skills found. Try a different search term.</p>
            </div>
          ) : (
            <div className="skills-grid">
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className="skill-card"
                  onClick={() => openSkill(skill)}
                >
                  <div className="skill-header">
                    <div>
                      <div className="skill-name">{skill.name}</div>
                      <div className="skill-repo">{skill.owner}/{skill.repo}</div>
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
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{selected.name}</h2>
              <button className="modal-close" onClick={() => setSelected(null)}>×</button>
            </div>
            <div className="modal-body">
              <div className="install-cmd">
                <code>asr add {selected.owner}/{selected.repo}/{selected.name}</code>
                <button className="copy-btn" onClick={copyInstallCmd}>
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <div className="skill-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(selected.content || selected.description)}</ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
  return window.location.pathname === '/review' ? <ReviewDashboard /> : <BrowseRegistry />;
}
