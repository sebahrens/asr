# Git Integration (Forgejo)

## Repository Structure

Single mono-repo (`skills-registry`) hosted on Forgejo as source of truth:

```
skills-registry/
├── skills/
│   └── {owner}/
│       └── {skill-name}/
│           ├── manifest.yaml
│           ├── SKILL.md
│           ├── scripts/                  (optional)
│           ├── CHANGELOG.md
│           ├── YANKED.md                 (only present once yanked)
│           └── .publish-record.json      (per-version metadata; see specs/versioning.md)
├── reviews/
│   └── {owner}/
│       └── {skill-name}/
│           ├── v1.0.0-scan.json
│           └── v1.0.0-decision.json
├── .forgejo/
│   └── workflows/
│       ├── validate-submission.yml
│       └── periodic-rescan.yml
└── registry.json                          (master index, regenerated on every publish)
```

Every published version has a Git tag `v{owner}--{name}--{version}` on its merge commit, so the per-version state is independently reconstructable from Git alone.

## Branch Strategy

```
main (protected)
  └── Published skills only
  └── Merge = publish
  └── Branch protection: status checks + approved review + merge whitelist + no force push

submit/{submission-id}
  └── Created by Submission Service on every submission (including MD-only auto-approve)
  └── Contains new/updated skill files
  └── CI runs validation; system review marks it approved when the workflow reaches `publish`
  └── Squash-merged into main; branch deleted after merge
```

The MD-only auto-approve path opens a PR with `auto-approve` label; the workflow's `publish` node uses the `merge` token to merge it. There is **no** direct push to `main` from any path.

## Forgejo API Usage

The Forgejo REST API at `/api/v1` is largely Octokit-compatible. We use `@octokit/rest` with a `baseUrl` override, but treat GitHub-only fields as unavailable.

### Known Forgejo ↔ GitHub Differences

| Concern | GitHub | Forgejo | What we do |
|---------|--------|---------|------------|
| Diff between two commits | `GET /repos/:o/:r/compare/:base...:head` returns `.files[]` | `GET /repos/:o/:r/compare/:base...:head` returns text diff (no `.files`); use `GET /repos/:o/:r/git/trees/{sha}?recursive=true` + per-blob compare | `forgejo.diffCommits` walks the tree pair and emits structured diff |
| Merge a PR | `Do: 'squash'` accepted | `Do: 'squash' \| 'merge' \| 'rebase'` accepted; `merge_message_field` is the commit message | Pass `Do: 'squash'` + `merge_message_field` explicitly |
| Webhook signature header | `X-Hub-Signature-256` | `X-Gitea-Signature` and `X-Forgejo-Signature` (HMAC-SHA256, hex) | Accept either; verify HMAC against `FORGEJO_WEBHOOK_SECRET` |
| Tree API for multi-file commit | `POST /git/trees` + `/git/commits` | Not exposed; use per-file `PUT /contents/:path` | Sequential per-file commit with retry/idempotency |
| Branch protection | `required_approving_review_count` | `required_approvals` + `merge_whitelist_usernames` | Use the `branch_protections` endpoint shape below |
| PR conflicts | API exposes `mergeable` | Forgejo also exposes `mergeable` after a refresh poll | Poll up to 5s after PR creation before declaring conflicts |

## Client (ForgejoClient)

Lives in `@asr/core/forgejo`. Constructed with two tokens (upload + merge) and the repo coordinates.

```typescript
import { Octokit } from '@octokit/rest';

export interface ForgejoConfig {
  baseUrl: string;                 // "https://forgejo.internal/api/v1"
  uploadToken: string;
  mergeToken: string;
  owner: string;                   // repo owner
  repo: string;                    // skills-registry
  defaultBranch?: string;          // default 'main'
}

export class ForgejoClient {
  private readonly upload: Octokit;
  private readonly merge: Octokit;

  constructor(private cfg: ForgejoConfig) {
    this.upload = new Octokit({ baseUrl: cfg.baseUrl, auth: cfg.uploadToken });
    this.merge  = new Octokit({ baseUrl: cfg.baseUrl, auth: cfg.mergeToken });
  }

  async openSubmissionPR(input: {
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  }): Promise<{ branch: string; prNumber: number; headSha: string }> {
    const { owner, repo } = this.cfg;
    const branch = `submit/${input.submissionId}`;

    // 1. Create branch — idempotent: 409 → branch exists, fetch its head sha
    let headSha: string;
    try {
      const { data } = await this.upload.request(
        'POST /repos/{owner}/{repo}/branches',
        { owner, repo, new_branch_name: branch, old_branch_name: this.cfg.defaultBranch ?? 'main' }
      );
      headSha = data.commit.id;
    } catch (e: any) {
      if (e.status !== 409) throw e;
      const { data } = await this.upload.request(
        'GET /repos/{owner}/{repo}/branches/{branch}', { owner, repo, branch }
      );
      headSha = data.commit.id;
    }

    // 2. Per-file commit (Forgejo has no tree API). Retry idempotent on 409 (file exists at same sha).
    const skillPath = `skills/${input.manifest.author}/${input.manifest.name}`;
    for (const f of input.files) {
      headSha = await this.putFile(branch, `${skillPath}/${f.path}`, f.content, input.submissionId);
    }

    // 3. Open PR (label auto-approve where applicable)
    const { data: pr } = await this.upload.request(
      'POST /repos/{owner}/{repo}/pulls',
      {
        owner, repo,
        title: `[Skill] ${input.manifest.name}@${input.manifest.version}`,
        head: branch, base: this.cfg.defaultBranch ?? 'main',
        body: prBody(input.manifest, input.submissionId, input.autoApprove),
        labels: input.autoApprove ? ['auto-approve'] : ['needs-review'],
      },
    );

    // 4. Wait for mergeable status (Forgejo computes on first read; poll briefly)
    await this.waitMergeable(pr.number);

    return { branch, prNumber: pr.number, headSha };
  }

  async mergePR(prNumber: number): Promise<{ sha: string }> {
    const { owner, repo } = this.cfg;
    try {
      await this.merge.request('POST /repos/{owner}/{repo}/pulls/{index}/merge', {
        owner, repo, index: prNumber,
        Do: 'squash',
        merge_message_field: `Approved and published (#${prNumber})`,
        delete_branch_after_merge: true,
      });
    } catch (e: any) {
      if (e.status !== 405 /* already merged */) throw e;
    }
    const { data } = await this.merge.request(
      'GET /repos/{owner}/{repo}/pulls/{index}', { owner, repo, index: prNumber }
    );
    if (!data.merge_commit_sha) throw new Error(`PR ${prNumber} not merged`);
    return { sha: data.merge_commit_sha };
  }

  async deleteBranch(branch: string): Promise<void> {
    const { owner, repo } = this.cfg;
    try {
      await this.merge.request(
        'DELETE /repos/{owner}/{repo}/branches/{branch}', { owner, repo, branch }
      );
    } catch (e: any) {
      if (e.status !== 404) throw e;
    }
  }

  async publishArtifact(input: {
    owner: string; name: string; version: string; zipBuffer: Buffer;
  }): Promise<string> {
    const base = this.cfg.baseUrl.replace(/\/api\/v1\/?$/, '');
    const url = `${base}/api/packages/${input.owner}/generic/${input.name}/${input.version}/skill.zip`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `token ${this.cfg.uploadToken}`, 'Content-Type': 'application/zip' },
      body: input.zipBuffer,
    });
    if (!res.ok && res.status !== 409 /* already uploaded */) throw new Error(`publishArtifact ${res.status}`);
    return url;
  }

  async diffCommits(baseSha: string, headSha: string): Promise<StructuredDiff> {
    // Implementation: GET /repos/:o/:r/git/trees/:sha?recursive=true for both shas,
    // diff the file lists, and per-blob compare via /repos/:o/:r/git/blobs/:sha.
    // Returns { added: [], removed: [], modified: [] }.
    ...
  }

  // ... putFile, waitMergeable helpers ...
}
```

`putFile` posts to `POST /repos/{owner}/{repo}/contents/{filepath}` with a deterministic commit message (`submit: <skill-path> (<submission-id>) [file <n>/<total>]`) so retries are recognisable in Git history.

## Branch Protection on `main`

Configured once on repo creation:

```typescript
await mergeClient.request('POST /repos/{owner}/{repo}/branch_protections', {
  owner, repo,
  branch_name: 'main',
  enable_push: true,
  enable_push_whitelist: true,
  push_whitelist_usernames: [],                       // nobody can push directly
  enable_merge_whitelist: true,
  merge_whitelist_usernames: ['asr-merge-bot'],       // only merge bot
  enable_status_check: true,
  status_check_contexts: ['validate-submission'],
  required_approvals: 1,
  block_on_rejected_reviews: true,
  block_on_outdated_branch: true,
  dismiss_stale_approvals: true,
  enable_force_push: false,
  enable_push_keys: false,
});
```

A bootstrap CLI script (`pnpm --filter @asr/submission run bootstrap-forgejo`) runs this against a fresh dev or prod Forgejo to make the repo correctly protected before the API ever processes a submission.

## Token Security

| Token | Created As | Scope | Used By |
|-------|-----------|-------|---------|
| `FORGEJO_UPLOAD_TOKEN` | Scoped PAT | `write:repository` on `skills-registry` | ForgejoClient (branches, commits, PRs, package upload) |
| `FORGEJO_MERGE_TOKEN` | Scoped PAT | `write:repository` + merge whitelist member | ForgejoClient (merge, branch deletion) |
| `FORGEJO_WEBHOOK_SECRET` | Random 32-byte | n/a | API webhook receiver |

In prod, secrets live in Azure Key Vault and are mounted as Container Apps secrets. In dev they live in `.env` (gitignored).

## Webhooks

Forgejo sends webhooks on PR events. The receiver:

| Event | Trigger | Action |
|-------|---------|--------|
| `pull_request` (opened) | Submission branch PR created | Confirm CI validation kicked off |
| `pull_request` (closed, merged=true) | PR merged to main | Update `skill_versions`, regenerate `registry.json`, emit `version.published` audit |
| `pull_request_review` | Review submitted | Update workflow state if relevant |

Signature verification: HMAC-SHA256 of the raw body keyed by `FORGEJO_WEBHOOK_SECRET`, compared against `X-Forgejo-Signature` (or `X-Gitea-Signature` for legacy compatibility), constant-time compare.

## Forgejo Actions

CI workflows in `.forgejo/workflows/` use Forgejo Actions, which is API-compatible with GitHub Actions for most third-party actions. Verified working:

- `actions/checkout@v4` (mirrored on Forgejo Actions runner)
- `actions/setup-node@v4`

Azure-specific actions (`azure/login@v2`) are not available natively on Forgejo Actions — for deploy workflows we use the `az` CLI directly with a service principal stored in Forgejo Actions secrets (named `AZURE_CREDENTIALS_JSON`, not `AZURE_CREDENTIALS` — Forgejo's secret resolver disallows generic names like `GITHUB_TOKEN`).

## Forgejo OIDC Configuration

Forgejo authenticates users via Entra ID for the web UI:

```ini
# app.ini additions
[oauth2_client]
ENABLE_AUTO_REGISTRATION = true
USERNAME = preferred_username
ACCOUNT_LINKING = auto

[service]
ALLOW_ONLY_EXTERNAL_REGISTRATION = true
SHOW_REGISTRATION_BUTTON = false
```

Authentication source (added via API or admin UI):
- **Provider**: OpenID Connect
- **Name**: `entra`
- **Client ID**: from Entra app registration
- **Discovery URL**: `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`
- **Scopes**: `openid email profile`
- **Callback URL**: `https://{forgejo-url}/user/oauth2/entra/callback`
- **Optional claims** on Entra app: `email`, `preferred_username` (workaround for Codeberg #7427)
