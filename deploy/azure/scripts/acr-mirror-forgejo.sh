#!/usr/bin/env bash
set -euo pipefail

# Mirrors codeberg.org/forgejo/forgejo:15 into the project's Azure Container
# Registry so Container Apps can pull it without an external dependency on
# cold start. See specs/deployment.md#forgejo-image-mirror. This is the one
# sanctioned place codeberg.org may appear in prod tooling.

if [[ -z "${ACR:-}" ]]; then
  echo "error: ACR environment variable is required (target Azure Container Registry name)" >&2
  exit 1
fi

az acr import --name "$ACR" --source codeberg.org/forgejo/forgejo:15 --image forgejo:15 --force

echo "Mirrored codeberg.org/forgejo/forgejo:15 into ${ACR}.azurecr.io/forgejo:15"
