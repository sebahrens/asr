#!/usr/bin/env bash
set -euo pipefail

# Builds the asr-api and asr-web container images in Azure Container Registry,
# tagged with the current git short SHA so each build is traceable to a commit
# and rollbackable. The Forgejo Actions deploy workflow runs the same commands
# inline (see specs/deployment.md#cicd-forgejo-actions); this script makes them
# runnable standalone from a developer laptop or an ops runbook.

if [[ -z "${ACR:-}" ]]; then
  echo "error: ACR environment variable is required (target Azure Container Registry name)" >&2
  exit 1
fi

GIT_SHA=$(git rev-parse --short HEAD)

az acr build --registry "$ACR" --image "asr-api:${GIT_SHA}" ./deploy/docker/api
az acr build --registry "$ACR" --image "asr-web:${GIT_SHA}" ./packages/web

echo "Built ${ACR}.azurecr.io/asr-api:${GIT_SHA} and ${ACR}.azurecr.io/asr-web:${GIT_SHA}"
