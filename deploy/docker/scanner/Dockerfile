FROM zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f AS gitleaks

FROM node:22-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS base

ARG TRIVY_VERSION=0.70.0
ARG TRIVY_AMD64_SHA256=8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9
ARG TRIVY_ARM64_SHA256=2f6bb988b553a1bbac6bdd1ce890f5e412439564e17522b88a4541b4f364fc8d
ARG FOXGUARD_VERSION=0.8.1
ARG FOXGUARD_TARBALL_SHA512=44693f4bfd1f15268fbdfb78d593078d33286e5163743b944c84dc13635f4fbc8a3e9f2088de080a4d65e1ef4cea43c2ff20c6541fe9bc8673ac50dd08cd89bc
ARG FOXGUARD_AMD64_SHA256=ad49914507d390888d4ae481dd7de2a0374e2a03fe1558603edc408daf303851
ARG FOXGUARD_ARM64_SHA256=a4e8faabdb814eb2eddf77c7c4b2dc5a36ce0fb7c463fa359e562bc2f2386e22
ARG OPENGREP_VERSION=1.22.0
ARG OPENGREP_AMD64_SHA256=45bcd58440e397ed52c50e953ccf5948909ea77087c9186fc7d277216f62e319
ARG OPENGREP_ARM64_SHA256=8df71670e20336646687c6f4ddf9b4532f1a7fcd8a8ea7bfa4ea46747f61e088
ARG VERACODE_CLI_VERSION=2.49.0
ARG INSTALL_VERACODE_CLI=false
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar gzip \
    && rm -rf /var/lib/apt/lists/*

# Gitleaks (MIT)
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks

# Trivy (Apache-2.0)
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) trivy_arch="64bit"; trivy_sha256="${TRIVY_AMD64_SHA256}" ;; \
      arm64) trivy_arch="ARM64"; trivy_sha256="${TRIVY_ARM64_SHA256}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    trivy_asset="trivy_${TRIVY_VERSION}_Linux-${trivy_arch}.tar.gz"; \
    trivy_url="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${trivy_asset}"; \
    curl -fsSLo "/tmp/${trivy_asset}" "${trivy_url}"; \
    echo "${trivy_sha256}  /tmp/${trivy_asset}" | sha256sum -c -; \
    tar -xzf "/tmp/${trivy_asset}" -C /usr/local/bin trivy; \
    rm -f "/tmp/${trivy_asset}"; \
    trivy --version \
    && trivy image --download-db-only

# Foxguard (MIT)
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) foxguard_arch="x86_64"; foxguard_sha256="${FOXGUARD_AMD64_SHA256}" ;; \
      arm64) foxguard_arch="aarch64"; foxguard_sha256="${FOXGUARD_ARM64_SHA256}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    npm pack "foxguard@${FOXGUARD_VERSION}" --pack-destination /tmp; \
    foxguard_tgz="/tmp/foxguard-${FOXGUARD_VERSION}.tgz"; \
    echo "${FOXGUARD_TARBALL_SHA512}  ${foxguard_tgz}" | sha512sum -c -; \
    npm install -g "${foxguard_tgz}"; \
    foxguard_cache="/usr/local/lib/node_modules/foxguard/node_modules/.cache/foxguard"; \
    mkdir -p "${foxguard_cache}"; \
    curl -fsSLo "${foxguard_cache}/foxguard" "https://github.com/0sec-labs/foxguard/releases/download/v${FOXGUARD_VERSION}/foxguard-linux-${foxguard_arch}"; \
    echo "${foxguard_sha256}  ${foxguard_cache}/foxguard" | sha256sum -c -; \
    chmod 0755 "${foxguard_cache}/foxguard"; \
    echo "${FOXGUARD_VERSION}" > "${foxguard_cache}/.version"; \
    foxguard --version \
    && npm cache clean --force \
    && rm -f "${foxguard_tgz}"

# Opengrep (LGPL-2.1)
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) opengrep_arch="x86"; opengrep_sha256="${OPENGREP_AMD64_SHA256}" ;; \
      arm64) opengrep_arch="aarch64"; opengrep_sha256="${OPENGREP_ARM64_SHA256}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/opengrep/opengrep/releases/download/v${OPENGREP_VERSION}/opengrep_manylinux_${opengrep_arch}" \
      -o /tmp/opengrep \
    && echo "${opengrep_sha256}  /tmp/opengrep" | sha256sum -c - \
    && install -m 0755 /tmp/opengrep /usr/local/bin/opengrep \
    && rm -f /tmp/opengrep \
    && opengrep --version

# Veracode CLI (proprietary, Tier 3 — optional enterprise).
# Upstream does not publish a per-version artifact digest for the shell
# installer. Keep this scanner image reproducible by failing closed instead of
# executing unverifiable installer output.
RUN set -eux; \
    if [ "${INSTALL_VERACODE_CLI}" != "false" ]; then \
      echo "Veracode CLI ${VERACODE_CLI_VERSION} is not installed: upstream installer verification is unavailable." >&2; \
      exit 1; \
    fi

COPY rules/ /opt/scan/rules/
COPY gitleaks.toml /opt/scan/gitleaks.toml
COPY trivy.yaml /opt/scan/trivy.yaml
COPY .trivyignore /opt/scan/.trivyignore

WORKDIR /scan
COPY scan-orchestrator.mjs /opt/scan/
ENTRYPOINT ["node", "/opt/scan/scan-orchestrator.mjs"]
