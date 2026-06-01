#!/bin/sh

if [ "$NODE_ENV" = "production" ] && [ "$AUTH_MODE" = "mock" ]; then
  echo "FATAL: AUTH_MODE=mock is forbidden in production" >&2
  exit 78
fi

if [ "${FORGEJO_BOOTSTRAP_BRANCH_PROTECTION:-}" = "true" ]; then
  if [ -n "$FORGEJO_URL" ] \
    && [ -n "$FORGEJO_UPLOAD_TOKEN" ] \
    && [ -n "$FORGEJO_MERGE_TOKEN" ] \
    && [ -n "$FORGEJO_OWNER" ] \
    && [ -n "$FORGEJO_REPO" ]; then
    node packages/submission/dist/bootstrap-forgejo.js
  else
    echo "Skipping Forgejo branch protection bootstrap: Forgejo repo/token env is incomplete" >&2
  fi
fi

exec "$@"
