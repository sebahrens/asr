# Auth route exemptions

`authMiddleware` only skips Entra/mock authentication for exact paths listed in
`EXEMPT_PATHS`. Do not add prefix exemptions for route families.

Public registry `GET /api/v1/skills...` routes are intentionally mounted before
`authMiddleware` in `index.ts`; mutating skill routes must be mounted after auth
and use `requireRole`.

Webhook routes must not rely on `authMiddleware` exemptions. Register each
`/webhooks/*` receiver with its own constant-time HMAC verifier, and reject
missing or invalid signatures before processing the payload.
