#!/bin/sh

if [ "$NODE_ENV" = "production" ] && [ "$AUTH_MODE" = "mock" ]; then
  echo "FATAL: AUTH_MODE=mock is forbidden in production" >&2
  exit 78
fi

exec "$@"
