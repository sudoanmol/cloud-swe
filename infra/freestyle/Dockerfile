# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04

ARG TARGETARCH=amd64
ARG NODE_MAJOR=24
ARG BUN_VERSION=1.4.0
ARG PNPM_VERSION=10
ARG CUA_DRIVER_VERSION=0.24.0

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# This is a local image recipe. VM-only user, service, and telemetry setup
# remains in bootstrap.sh. Both recipes consume the same package capability list.
RUN if [ "$TARGETARCH" != "amd64" ]; then \
      echo "Unsupported TARGETARCH: $TARGETARCH; the Freestyle image is amd64-only" >&2; \
      exit 1; \
    fi

COPY infra/freestyle/capabilities.list /tmp/cloud-swe-capabilities.list
RUN apt-get update \
  && awk 'NF && $1 !~ /^#/' /tmp/cloud-swe-capabilities.list \
    | xargs -r apt-get install -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* /tmp/cloud-swe-capabilities.list

RUN apt-get update \
  && curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
  && ln -sfn /usr/bin/google-chrome /usr/local/bin/chromium \
  && rm -f /tmp/google-chrome.deb \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://get.docker.com -o /tmp/get-docker.sh \
  && sh /tmp/get-docker.sh \
  && rm -f /tmp/get-docker.sh

RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource.sh \
  && bash /tmp/nodesource.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* /tmp/nodesource.sh \
  && npm install --global "pnpm@$PNPM_VERSION"

RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip" -o /tmp/bun.zip \
  && unzip -q /tmp/bun.zip -d /opt \
  && install -m 0755 /opt/bun-linux-x64/bun /usr/local/bin/bun \
  && rm -rf /tmp/bun.zip /opt/bun-linux-x64

RUN curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh \
  && sh /tmp/uv-install.sh \
  && install -m 0755 /root/.local/bin/uv /usr/local/bin/uv \
  && install -m 0755 /root/.local/bin/uvx /usr/local/bin/uvx \
  && sed -i '/\.local\/bin\/env/d' /root/.profile \
  && rm -rf /tmp/uv-install.sh /root/.local

RUN curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-install.sh \
  && CUA_DRIVER_RS_VERSION=$CUA_DRIVER_VERSION bash /tmp/cua-install.sh --bin-dir /usr/local/bin --no-modify-path \
  && install -d -m 0755 /opt/cua-driver \
  && cp -aL /root/.cua-driver/packages/current/. /opt/cua-driver/ \
  && rm -f /usr/local/bin/cua-driver \
  && ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver \
  && rm -rf /root/.cua-driver /tmp/cua-install.sh

RUN install -d -m 0775 /workspace
WORKDIR /workspace
CMD ["/bin/bash", "-lc", "sleep infinity"]
