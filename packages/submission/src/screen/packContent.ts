import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SkillManifest } from '@asr/core';

const DEFAULT_CONTEXT_TOKENS = 200_000;
const DEFAULT_RESERVE_OUTPUT_TOKENS = 8_000;
const DEFAULT_CHARS_PER_TOKEN = 3.5;
const DEFAULT_SAFETY_MARGIN_TOKENS = 1_000;

const BINARY_OR_IMAGE_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bmp',
  '.bz2',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.pyc',
  '.so',
  '.tar',
  '.tgz',
  '.ttf',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip',
]);

export interface PackContentInput {
  extractedDir: string;
  manifest: SkillManifest;
  questionnaireResponses?: unknown;
  estimatedRubricTokens: number;
  contextTokens?: number;
  reserveOutputTokens?: number;
  charsPerToken?: number;
  safetyMarginTokens?: number;
}

export interface PackedContent {
  content: string;
  truncated: boolean;
  includedFiles: string[];
  skippedFiles: string[];
  budgetTokens: number;
  estimatedTokens: number;
}

export async function packContent(input: PackContentInput): Promise<PackedContent> {
  const contextTokens = input.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const reserveOutputTokens = input.reserveOutputTokens ?? DEFAULT_RESERVE_OUTPUT_TOKENS;
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const safetyMarginTokens = input.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  const budgetTokens = Math.max(
    0,
    Math.floor(
      contextTokens - input.estimatedRubricTokens - reserveOutputTokens - safetyMarginTokens,
    ),
  );
  const budgetChars = Math.floor(budgetTokens * charsPerToken);

  const declaredStatements = declaredStatementsBlock(input.manifest, input.questionnaireResponses);
  const files = await listFiles(input.extractedDir);
  const includedFiles: string[] = [];
  const skippedFiles = files.filter(isBinaryOrImagePath);
  const packableFiles = files.filter((file) => !isBinaryOrImagePath(file));

  let content = '';
  let truncated = false;

  const append = (chunk: string): boolean => {
    if (content.length + chunk.length <= budgetChars) {
      content += chunk;
      return true;
    }

    const remainingChars = budgetChars - content.length;
    if (remainingChars > 0) {
      content += chunk.slice(0, remainingChars);
    }
    truncated = true;
    return false;
  };

  if (!append(declaredStatements)) {
    return {
      content,
      truncated,
      includedFiles,
      skippedFiles,
      budgetTokens,
      estimatedTokens: estimateTokens(content, charsPerToken),
    };
  }

  for (const file of packableFiles) {
    const absolutePath = join(input.extractedDir, file);
    const raw = await readFile(absolutePath, 'utf8');
    const normalized = raw.replace(/\r\n?/g, '\n');
    const packedFile = packFileWithLineLocations(file, normalized);

    if (!append(packedFile)) {
      break;
    }

    includedFiles.push(file);
  }

  if (includedFiles.length < packableFiles.length) {
    truncated = true;
  }

  return {
    content,
    truncated,
    includedFiles,
    skippedFiles,
    budgetTokens,
    estimatedTokens: estimateTokens(content, charsPerToken),
  };
}

function declaredStatementsBlock(manifest: SkillManifest, questionnaireResponses: unknown): string {
  return [
    '# Declared statements',
    '',
    '## Permissions manifest',
    JSON.stringify(manifest.permissions, null, 2),
    '',
    '## Skill description',
    manifest.description,
    '',
    '## Questionnaire answers',
    questionnaireResponses === undefined
      ? '(none submitted)'
      : JSON.stringify(questionnaireResponses, null, 2),
    '',
    '# Extracted content',
    '',
  ].join('\n');
}

function packFileWithLineLocations(file: string, content: string): string {
  const lines = content.split('\n');
  const numbered = lines.map((line, index) => `${file}:${index + 1} ${line}`);
  return [`## ${file}`, ...numbered, ''].join('\n');
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => comparePaths(a.name, b.name));

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(toPosixPath(relative(root, absolutePath)));
      }
    }
  }

  await walk(root);
  return files.sort(comparePaths);
}

function isBinaryOrImagePath(file: string): boolean {
  const dot = file.lastIndexOf('.');
  if (dot === -1) {
    return false;
  }
  return BINARY_OR_IMAGE_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function estimateTokens(content: string, charsPerToken: number): number {
  if (content.length === 0) {
    return 0;
  }
  return Math.ceil(content.length / charsPerToken);
}

function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
