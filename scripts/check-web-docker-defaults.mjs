import { readFileSync } from 'node:fs';

const dockerfile = readFileSync('deploy/docker/Dockerfile.web', 'utf8');
const compose = readFileSync('deploy/docker/docker-compose.yml', 'utf8');

const failures = [];

function requireIncludes(content, expected, file) {
  if (!content.includes(expected)) {
    failures.push(`${file}: expected to include ${expected}`);
  }
}

function requireNotIncludes(content, forbidden, file) {
  if (content.includes(forbidden)) {
    failures.push(`${file}: must not include ${forbidden}`);
  }
}

requireIncludes(dockerfile, 'ARG ASR_WEB_BUILD_PROFILE=production', 'Dockerfile.web');
requireIncludes(dockerfile, 'ARG VITE_API_URL=/api', 'Dockerfile.web');
requireIncludes(dockerfile, 'ARG VITE_AUTH_MODE=msal', 'Dockerfile.web');
requireIncludes(dockerfile, 'ARG VITE_ENABLE_MOCK_AUTH=false', 'Dockerfile.web');
requireIncludes(dockerfile, 'Production web image builds must not enable mock auth', 'Dockerfile.web');
requireNotIncludes(dockerfile, 'ARG VITE_API_URL=http://localhost:3001', 'Dockerfile.web');
requireNotIncludes(dockerfile, 'ARG VITE_AUTH_MODE=mock', 'Dockerfile.web');
requireNotIncludes(dockerfile, 'ARG VITE_ENABLE_MOCK_AUTH=true', 'Dockerfile.web');

requireIncludes(compose, 'ASR_WEB_BUILD_PROFILE=development', 'docker-compose.yml');
requireIncludes(compose, 'VITE_API_URL=/api', 'docker-compose.yml');
requireIncludes(compose, 'VITE_AUTH_MODE=mock', 'docker-compose.yml');
requireIncludes(compose, 'VITE_ENABLE_MOCK_AUTH=true', 'docker-compose.yml');
requireNotIncludes(compose, 'VITE_API_URL=http://localhost:3001', 'docker-compose.yml');

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
