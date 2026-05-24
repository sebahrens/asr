import http from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);

const skills = [
  {
    id: 'office-companion/write-docs',
    owner: 'office-companion',
    repo: 'skills-registry',
    name: 'write-docs',
    description: 'Draft and refine documentation for agent workflows.',
    tags: ['docs', 'writing'],
    stars: 18,
    installs: 42,
    version: '0.1.0',
    updated_at: '2026-05-24T00:00:00.000Z',
  },
  {
    id: 'asr/security-review',
    owner: 'asr',
    repo: 'skills-registry',
    name: 'security-review',
    description: 'Review submitted skills for unsafe instructions and secrets.',
    tags: ['security', 'review'],
    stars: 11,
    installs: 17,
    version: '0.1.0',
    updated_at: '2026-05-24T00:00:00.000Z',
  },
];

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res) {
  json(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/api/health') {
    json(res, 200, { status: 'ok' });
    return;
  }

  if (url.pathname === '/api/skills') {
    const query = url.searchParams.get('q')?.toLowerCase().trim();
    const filtered = query
      ? skills.filter((skill) => {
          return [
            skill.owner,
            skill.repo,
            skill.name,
            skill.description,
            ...skill.tags,
          ].some((value) => value.toLowerCase().includes(query));
        })
      : skills;
    json(res, 200, { skills: filtered });
    return;
  }

  const match = url.pathname.match(/^\/api\/skills\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (match) {
    const [, owner, repo, name] = match;
    const skill = skills.find((item) => {
      return item.owner === owner && item.repo === repo && item.name === name;
    });

    if (!skill) {
      notFound(res);
      return;
    }

    json(res, 200, {
      ...skill,
      content: `# ${skill.name}\n\n${skill.description}\n\n## Usage\n\nRun \`asr add ${skill.owner}/${skill.repo}/${skill.name}\` to install this skill.`,
    });
    return;
  }

  notFound(res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ASR dev API listening on http://0.0.0.0:${port}`);
});
