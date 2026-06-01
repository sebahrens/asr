import { readFileSync } from 'node:fs';

const dockerfile = readFileSync('deploy/docker/scanner/Dockerfile', 'utf8');

function requireIncludes(content, expected, label) {
  if (!content.includes(expected)) {
    throw new Error(`Missing ${label}: ${expected}`);
  }
}

function requireNotMatches(content, pattern, label) {
  if (pattern.test(content)) {
    throw new Error(`Disallowed ${label} in deploy/docker/scanner/Dockerfile`);
  }
}

requireIncludes(
  dockerfile,
  'FROM zricethezav/gitleaks:v8.30.1@sha256:',
  'Gitleaks base image digest pin',
);
requireIncludes(dockerfile, 'FROM node:22-slim@sha256:', 'Node base image digest pin');

for (const argName of [
  'TRIVY_AMD64_SHA256',
  'TRIVY_ARM64_SHA256',
  'FOXGUARD_TARBALL_SHA512',
  'FOXGUARD_AMD64_SHA256',
  'FOXGUARD_ARM64_SHA256',
  'OPENGREP_AMD64_SHA256',
  'OPENGREP_ARM64_SHA256',
]) {
  requireIncludes(dockerfile, `ARG ${argName}=`, `${argName} checksum ARG`);
  requireIncludes(dockerfile, `${argName}}`, `${argName} checksum use`);
}

requireIncludes(dockerfile, 'sha256sum -c -', 'sha256 verification');
requireIncludes(dockerfile, 'sha512sum -c -', 'sha512 verification');
requireIncludes(dockerfile, 'foxguard-linux-${foxguard_arch}', 'verified Foxguard native binary preload');
requireIncludes(dockerfile, 'INSTALL_VERACODE_CLI=false', 'Veracode fail-closed default');

requireNotMatches(dockerfile, /\|\s*(?:[A-Z0-9_="-]+\s+)*sh\b/, 'downloaded script pipe to shell');
requireNotMatches(dockerfile, /install\.sh/, 'remote install.sh usage');
requireNotMatches(dockerfile, /npm install -g "foxguard@\$\{FOXGUARD_VERSION\}"/, 'unverified Foxguard install');
requireNotMatches(dockerfile, /-o \/usr\/local\/bin\/opengrep/, 'Opengrep chmod before checksum');
requireNotMatches(dockerfile, /\|\|\s*true/, 'ignored scanner installer failure');
