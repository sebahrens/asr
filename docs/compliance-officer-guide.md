# Compliance Officer Operations Guide

This guide is the operational reference for compliance reviewers working with the Agent Skills Registry (ASR). It consolidates role assignments, response SLAs, scan-verdict interpretation, and audit-chain verification — material that is otherwise scattered across the canonical specs.

If anything below conflicts with the linked spec, the spec wins. File an issue rather than acting on the stale prose.

## Role matrix and separation of duties

ASR recognises three principal roles, mapped from Entra ID group claims:

| Role | Can submit | Can scan / view findings | Can approve / reject | Can override admin gates |
|------|------------|--------------------------|----------------------|--------------------------|
| Submitter  | Yes | Own submissions only | No  | No  |
| Compliance | Yes | All submissions       | Yes | No  |
| Admin      | Yes | All submissions       | Yes | Yes |

A reviewer with the `Compliance` role may **never** approve their own submission. This is the project's core separation of duties guarantee, and it is enforced at two layers:

1. The Flowcraft HITL node declares the submitter as a `forbiddenActor`, so the reviewer queue will not even surface the item to its submitter.
2. The `POST /submissions/:id/approve` and `/reject` handlers re-check that the caller's Entra `sub` differs from `submission.submittedBy` at decision time. A reviewer who picks up an item and then loses the `Compliance` role (or who tries to approve their own work via the API) has their decision rejected at submit time with `403 self_review_forbidden`.

If you legitimately need a different reviewer to look at an item that has been sitting in your personal queue, leave a queue note and another compliance officer will pick it up — do not ask an Admin to "force-approve" your own submission.

See [specs/workflow.md#separation-of-duties](../specs/workflow.md#separation-of-duties).

## Review SLA windows

Each pipeline stage has a deadline; missing the deadline triggers a structured escalation rather than silent stalls. The relevant stages for compliance officers:

| Stage | Window | On expiry |
|-------|--------|-----------|
| Questionnaire     | 7 days  | Notify submitter, extend 7 days, then auto-reject |
| User confirmation | 14 days | Auto-reject |
| Compliance review | 30 days | Escalate to Admin, extend 7 days, then auto-reject |

For the compliance review stage specifically:

- Day 0 is the moment the submission enters the `awaiting_compliance` state. The 30-day clock is in calendar days, not business days.
- At day 30 the scheduler emits an escalation notification to the Admin group and grants a 7-day extension. The item stays in the queue and remains assignable to any compliance officer — admin escalation is informational, not a hand-off.
- At day 37 (30 + 7) the item is auto-rejected with `detail.reason='timeout'` and a `workflow.review.rejected` audit event. The submitter may resubmit a new version; the rejected revision is preserved for the audit trail.

If you know you cannot review an item in time, leave it unassigned — do not let it expire silently. The auto-reject path is a fail-safe, not a scheduling tool.

See [specs/workflow.md#timeout-and-expiry](../specs/workflow.md#timeout-and-expiry).

## Reading scan verdicts and overrides

Every submission produces a `ScanReport` aggregating findings from Gitleaks (secrets), Trivy (dependencies), Foxguard (misuse), Opengrep (static analysis), and optionally Veracode. The pipeline normalises tool-specific severities to `critical`, `high`, `medium`, `low`, then computes a single verdict:

| Verdict | Meaning | Reviewer action |
|---------|---------|-----------------|
| `pass`            | No critical, no high, no secret findings. | Approve unless a non-security concern (license, manifest, content) is in scope. |
| `review_required` | One or more `high`-severity findings, no criticals, no secrets. | Read each finding; approve with a documented override **or** reject. |
| `block`           | Any `critical` finding, **or** any Gitleaks (secret) finding regardless of severity. | Hard auto-reject — the API closes the submission before it reaches your queue. You cannot override `block`. |

Key rules to internalise:

- **Critical = hard auto-reject.** You should never see a `block`-verdict submission in your queue. If you do, treat it as a workflow bug and file it.
- **Any secret finding is always a hard block.** Gitleaks output bypasses the normal severity threshold. There is no "the secret is fake" override path at the verdict level; the submitter must remove the secret and resubmit.
- **High = `review_required`.** This is the only case where a compliance officer's judgment is the gating decision. Approving a `review_required` item is an explicit override and is recorded as such in the audit event.

When you override a high-severity finding, the decision payload must include a non-empty `overrideReason` per finding ID. The audit event records the finding hashes you waived, so a future reviewer can reconstruct what was accepted and why. Medium findings are advisory: shown to you but not part of the override accounting. Low findings are not shown by default — pull them from the report detail view if you want them.

See [specs/security-scanning.md#blocking-rules](../specs/security-scanning.md#blocking-rules).

## Verifying the audit chain and anchoring

The audit log is an append-only HMAC chain: each event embeds the hash of the previous event, signed with a key from a rotating KeyRing. Two operator-facing checks let you confirm history has not been tampered with.

### Live chain verification

`GET /audit/verify` walks the audit table from the genesis event forward, recomputing each row's HMAC and asserting that `event.prev_hash` matches the previous row's `hash`. Possible outcomes:

- `200 { valid: true, eventCount, lastHash }` — the chain is intact end-to-end as of this moment.
- `200 { valid: false, brokenAt, reason }` — verification failed at a specific event. Reasons include `prev_hash mismatch`, `hash mismatch`, or `unknown key`.

A `valid: false` response is not just informational. The API enters **degraded mode** automatically: all write endpoints return `503 audit_chain_broken`, the dashboard shows a red banner, and on-call is paged via the `audit.verify.failed > 0 in 5m` alert rule. Degraded mode is cleared only after an admin investigates and acknowledges; do not approve or reject anything while the API is in this state.

`GET /audit/verify` requires the `Admin` role. Compliance officers who want a sanity check can use the per-skill or per-submission audit views (`/audit/skill/:owner/:name`, `/audit/submission/:id`) — these queries fail the same way if the underlying rows do not verify.

See [specs/audit.md#chain-verification](../specs/audit.md#chain-verification).

### External anchoring

The HMAC key lives in Azure Key Vault, so an attacker with database write access still cannot forge new events without also stealing the active key. To detect *replacement* of history (where an attacker substitutes an entire prefix of the chain with one signed by a key they control), an anchor job runs every 100 events or every hour, whichever comes first:

1. It reads the latest `hash` from `audit_events`.
2. It creates a signed Forgejo tag `audit-anchor-{YYYYMMDDTHHMMSSZ}` in the `skills-registry` repo whose message contains `{lastHash, eventCount, hmacKeyId}`.
3. The tag is signed with a dedicated GPG key whose private half lives only in Key Vault and is loaded by the anchor job on startup.
4. An `audit.anchored` event is appended to the chain itself, recording the tag name and commit sha.

To independently confirm a historical claim, fetch the anchor tag from Forgejo, verify the GPG signature against the published public key, and compare the `lastHash` in the tag message to the hash returned by `GET /audit/verify` for the same `eventCount`. If they match, no event up to that point can have been replaced without also producing a second valid signature from the Key Vault GPG key.

See [specs/audit.md#external-anchoring](../specs/audit.md#external-anchoring).
