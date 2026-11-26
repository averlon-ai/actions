# UPSTREAM @openai/codex-security, unmodified, for the codex-security workflow.
#
# No patches: codex-security and the stock Codex it pins (@openai/codex, an
# exact-version npm dependency) are installed from the npm registry as published,
# and the tarball must match the sha256 below before anything is installed. The
# cynos endpoint is plain Codex configuration passed with --codex (src/docker.ts),
# not a code change. No credentials are baked in: the key arrives at run time
# through `docker run -e CYNOS_API_KEY`.
#
#   docker build -t cynos-scan-scanner:0.9.1 packages/engine/assets
#
# The base is the multi-arch index digest of node:24-bookworm-slim, so the same
# pin builds natively on amd64 and arm64 runners and laptops. It is written in the
# FROM line itself, where Dependabot can update it.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ARG CODEX_SECURITY_VERSION=0.9.1
ARG CODEX_SECURITY_SHA256=f36c9b5dd9bc8c91b772d4a208034f69daca8baadd60f0ced388e40d69eb21f0

# git: codex-security reads repository metadata. python3: the plugin's helper
# scripts (draft checks, finalizer, SARIF exporter). ripgrep: Codex's preferred
# search tool.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Verify the registry tarball before installing it, and keep its checksum so
# versions.sh can report the exact package a run used. The package ships no
# shrinkwrap, so transitive dependencies resolve at build time; versions.sh
# hashes the installed tree to make that drift visible.
WORKDIR /opt/codex-security
RUN npm pack "@openai/codex-security@${CODEX_SECURITY_VERSION}" \
 && echo "${CODEX_SECURITY_SHA256}  openai-codex-security-${CODEX_SECURITY_VERSION}.tgz" | sha256sum -c - \
 && sha256sum "openai-codex-security-${CODEX_SECURITY_VERSION}.tgz" > codex-security.tgz.sha256 \
 && npm install -g --no-fund --no-audit "./openai-codex-security-${CODEX_SECURITY_VERSION}.tgz" \
 && rm "openai-codex-security-${CODEX_SECURITY_VERSION}.tgz" \
 && npm cache clean --force \
 && test -f "$(npm root -g)/@openai/codex-security/node_modules/@openai/codex/bin/codex.js"

COPY entrypoint.sh versions.sh /opt/codex-security/
RUN chmod 0755 /opt/codex-security/entrypoint.sh /opt/codex-security/versions.sh

# codebase-memory-mcp, the code graph the knowledge base reads functions and calls from
# (src/knowledge-base/code-graph.ts runs it in this image with no network). A pinned release,
# checked against its published sha256 before extraction, for the architecture the image is
# built for.
ARG TARGETARCH
ARG CBM_VERSION=v0.11.0
ARG CBM_SHA256_AMD64=1f9e8293eb2bc5c05cfa27a7e8fc033da6d729ffad525ccfcdaa3fd606306683
ARG CBM_SHA256_ARM64=d62eeb224d5ee3eba3070938ec62cf1033f10b041ec1c4b2fb67f7aef390cc7b
ADD --chmod=0644 "https://github.com/DeusData/codebase-memory-mcp/releases/download/${CBM_VERSION}/codebase-memory-mcp-linux-${TARGETARCH}-portable.tar.gz" /tmp/cbm.tar.gz
RUN case "${TARGETARCH}" in \
      amd64) sum="${CBM_SHA256_AMD64}" ;; \
      arm64) sum="${CBM_SHA256_ARM64}" ;; \
      *) echo "no codebase-memory-mcp build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && echo "${sum}  /tmp/cbm.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/cbm.tar.gz -C /usr/local/bin codebase-memory-mcp \
 && chmod 0755 /usr/local/bin/codebase-memory-mcp \
 && rm /tmp/cbm.tar.gz

# Unprivileged scan user (the base image's uid 1000). The workflow runs the
# container as the runner's uid instead, so the mounted 0700 directories stay
# writable; HOME is then pointed into the mounted state directory.
USER node
WORKDIR /home/node
ENTRYPOINT ["/opt/codex-security/entrypoint.sh"]
