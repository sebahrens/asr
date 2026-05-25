import http from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);

const skills = [
  {
    owner: 'office-companion',
    name: 'write-docs',
    description: 'Draft and refine documentation for agent workflows.',
    tags: ['docs', 'writing'],
    kind: 'skill',
    latestVersion: '0.1.0',
    publishedAt: '2026-05-24T00:00:00.000Z',
    downloadCount: 42,
    riskAssessmentLatest: 'low',
  },
  {
    owner: 'asr',
    name: 'security-review',
    description: 'Review submitted skills for unsafe instructions and secrets.',
    tags: ['security', 'review'],
    kind: 'skill',
    latestVersion: '0.1.0',
    publishedAt: '2026-05-24T00:00:00.000Z',
    downloadCount: 17,
    riskAssessmentLatest: 'medium',
  },
];

const seededSubmissions = [
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

const submissions = seededSubmissions.map((submission) => ({ ...submission }));
let nextSubmissionNumber = 2000;

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res) {
  json(res, 404, { error: 'not_found' });
}

function methodNotAllowed(res) {
  json(res, 405, { error: 'method_not_allowed' });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readMultipartFields(req) {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];

  if (!boundary) {
    return {};
  }

  const body = (await readRequestBody(req)).toString('utf8');
  const fields = {};

  for (const part of body.split(`--${boundary}`)) {
    const name = part.match(/content-disposition:[^\n]*\bname="([^"]+)"/i)?.[1];
    if (!name || part.includes('filename=')) {
      continue;
    }

    const valueStart = part.indexOf('\r\n\r\n');
    if (valueStart === -1) {
      continue;
    }

    fields[name] = part.slice(valueStart + 4).replace(/\r\n--$/, '').trim();
  }

  return fields;
}

function readFrontmatterValue(markdown, key) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---/)?.[1];
  return frontmatter?.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
}

function createSubmission(fields) {
  const skillMd = fields.skillMd ?? '';
  const owner = fields.owner?.trim() || readFrontmatterValue(skillMd, 'author') || 'local';
  const skillName = readFrontmatterValue(skillMd, 'name') || 'uploaded-skill';
  const version = readFrontmatterValue(skillMd, 'version') || '0.1.0';
  const now = new Date().toISOString();
  const id = `sub-${nextSubmissionNumber++}`;
  const manifest = {
    name: skillName,
    version,
    author: owner,
    description: readFrontmatterValue(skillMd, 'description') || 'Local development submission',
    tags: [],
    kind: readFrontmatterValue(skillMd, 'kind') || 'skill',
  };
  const submission = {
    id,
    skillName,
    owner,
    version,
    submitter: 'dev-user',
    submittedAt: now,
    status: 'pending review',
    risk: 'low',
    findings: 0,
  };

  submissions.unshift(submission);

  return {
    id,
    status: { phase: 'uploaded' },
    manifest,
    contentHash: `sha256:dev-${owner}-${skillName}-${version}`,
    createdAt: now,
    submission,
  };
}

function findSkills(query) {
  const normalizedQuery = query?.toLowerCase().trim();
  return normalizedQuery
    ? skills.filter((skill) => {
        return [
          skill.owner,
          skill.name,
          skill.description,
          ...skill.tags,
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
    : skills;
}

function getSkillContent(skill) {
  return `---
name: ${skill.name}
version: ${skill.latestVersion}
author: ${skill.owner}
description: ${skill.description}
tags:
${skill.tags.map((tag) => `  - ${tag}`).join('\n')}
kind: ${skill.kind}
---

# ${skill.name}

${skill.description}

## Usage

Run \`asr install ${skill.owner}/${skill.name}\` to install this skill.

## Review Checklist

| Check | Evidence |
| --- | --- |
| Secrets | Inspect uploaded files and scanner findings |
| Permissions | Compare requested access with stated purpose |

## Example Finding

\`\`\`text
severity: high
file: SKILL.md
message: External exfiltration instruction detected
\`\`\`

## Links

- [ASR workflow](/review)`;
}

function getSkillDetail(skill) {
  const skillMd = getSkillContent(skill);

  return {
    ...skill,
    manifestLatest: {
      name: skill.name,
      version: skill.latestVersion,
      author: skill.owner,
      description: skill.description,
      tags: skill.tags,
      kind: skill.kind,
      permissions: {
        network: false,
        filesystem: 'none',
        subprocess: false,
        environment: [],
      },
    },
    skillMd,
    versions: [
      {
        owner: skill.owner,
        name: skill.name,
        version: skill.latestVersion,
        contentHash: `sha256:dev-${skill.owner}-${skill.name}`,
        publishedAt: skill.publishedAt,
        publishedBy: `${skill.owner}@example.test`,
        approvedBy: 'mock-compliance@example.test',
        prNumber: 1,
        mergeCommit: 'dev-seed',
        yanked: false,
        riskAssessment: skill.riskAssessmentLatest,
      },
    ],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    });
    res.end();
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/api/health') {
    if (req.method !== 'GET') {
      methodNotAllowed(res);
      return;
    }

    json(res, 200, { status: 'ok' });
    return;
  }

  if (url.pathname === '/api/v1/skills' || url.pathname === '/api/skills') {
    if (req.method !== 'GET') {
      methodNotAllowed(res);
      return;
    }

    const filtered = findSkills(url.searchParams.get('q'));
    json(res, 200, url.pathname === '/api/skills' ? { skills: filtered } : { items: filtered });
    return;
  }

  const match = url.pathname.match(/^\/api\/(?:v1\/)?skills\/([^/]+)\/([^/]+)$/);
  if (match) {
    if (req.method !== 'GET') {
      methodNotAllowed(res);
      return;
    }

    const [, owner, name] = match;
    const skill = skills.find((item) => {
      return item.owner === owner && item.name === name;
    });

    if (!skill) {
      notFound(res);
      return;
    }

    json(res, 200, getSkillDetail(skill));
    return;
  }

  if (url.pathname === '/api/v1/submissions') {
    if (req.method === 'POST') {
      readMultipartFields(req)
        .then((fields) => {
          json(res, 201, createSubmission(fields));
        })
        .catch(() => {
          json(res, 400, {
            error: 'invalid_submission',
            message: 'Submission multipart body could not be read.',
          });
        });
      return;
    }

    if (req.method !== 'GET') {
      methodNotAllowed(res);
      return;
    }

    const status = url.searchParams.get('status');
    const filtered = status === 'pending'
      ? submissions.filter((submission) => submission.status === 'pending review')
      : submissions;
    json(res, 200, { submissions: filtered });
    return;
  }

  const decisionMatch = url.pathname.match(/^\/api\/v1\/submissions\/([^/]+)\/(approve|reject)$/);
  if (decisionMatch) {
    if (req.method !== 'POST') {
      methodNotAllowed(res);
      return;
    }

    const [, id, decision] = decisionMatch;
    const submission = submissions.find((item) => item.id === id);
    if (!submission) {
      notFound(res);
      return;
    }

    if (submission.status !== 'pending review') {
      json(res, 409, {
        error: 'submission_not_reviewable',
        message: `Submission ${id} is ${submission.status}.`,
      });
      return;
    }

    submission.status = decision === 'approve' ? 'approved' : 'rejected';
    json(res, 200, {
      submission,
      status: {
        phase: submission.status,
      },
    });
    return;
  }

  notFound(res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ASR dev API listening on http://0.0.0.0:${port}`);
});
