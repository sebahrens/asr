FROM zricethezav/gitleaks:v8.30.1 AS gitleaks

FROM node:22-slim AS base

ARG TRIVY_VERSION=0.70.0
ARG FOXGUARD_VERSION=0.8.1
ARG OPENGREP_VERSION=1.22.0
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar gzip \
    && rm -rf /var/lib/apt/lists/*

# Gitleaks (MIT)
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks

# Trivy (Apache-2.0)
RUN curl -sfL "https://raw.githubusercontent.com/aquasecurity/trivy/v${TRIVY_VERSION}/contrib/install.sh" \
    | sh -s -- -b /usr/local/bin "v${TRIVY_VERSION}" \
    && trivy image --download-db-only

# Foxguard (MIT)
RUN npm install -g "foxguard@${FOXGUARD_VERSION}" \
    && foxguard --version \
    && npm cache clean --force

# Opengrep (LGPL-2.1)
RUN case "${TARGETARCH}" in \
      amd64) opengrep_arch="x86" ;; \
      arm64) opengrep_arch="aarch64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/opengrep/opengrep/releases/download/v${OPENGREP_VERSION}/opengrep_manylinux_${opengrep_arch}" \
      -o /usr/local/bin/opengrep \
    && chmod 0755 /usr/local/bin/opengrep

COPY rules/ /opt/scan/rules/

WORKDIR /scan
COPY scan-orchestrator.mjs /opt/scan/
ENTRYPOINT ["node", "/opt/scan/scan-orchestrator.mjs"]
