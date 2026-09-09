# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04

ARG TARGETARCH
ARG NODE_MAJOR=24
ARG BUN_VERSION=1.4.0
ARG PNPM_VERSION=10
ARG CUA_DRIVER_VERSION=0.24.0

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    at-spi2-core \
    build-essential \
    ca-certificates \
    cargo \
    curl \
    dbus \
    dbus-x11 \
    file \
    fonts-liberation \
    fonts-noto-color-emoji \
    git \
    gnupg \
    golang-go \
    iproute2 \
    jq \
    libasound2t64 \
    libnss3 \
    net-tools \
    novnc \
    openbox \
    procps \
    python3 \
    python-is-python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    rustc \
    scrot \
    systemd \
    systemd-sysv \
    tzdata \
    unzip \
    websockify \
    x11-utils \
    x11vnc \
    xauth \
    xdotool \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) \
        apt-get update \
        && curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
        && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
        && ln -s /usr/bin/google-chrome /usr/local/bin/chromium \
        && rm -f /tmp/google-chrome.deb \
        && rm -rf /var/lib/apt/lists/* ;; \
      arm64) \
        apt-get update \
        && apt-get install -y --no-install-recommends chromium \
        && ln -s /usr/bin/chromium-browser /usr/local/bin/chromium \
        && rm -rf /var/lib/apt/lists/* ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac

RUN curl -fsSL https://get.docker.com -o /tmp/get-docker.sh \
  && sh /tmp/get-docker.sh \
  && rm -f /tmp/get-docker.sh

RUN curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x -o /tmp/nodesource.sh \
  && bash /tmp/nodesource.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* /tmp/nodesource.sh \
  && npm install --global pnpm@$PNPM_VERSION

RUN case "$TARGETARCH" in \
      amd64) bun_arch=x64 ;; \
      arm64) bun_arch=aarch64 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$bun_arch.zip" -o /tmp/bun.zip \
  && unzip -q /tmp/bun.zip -d /opt \
  && install -m 0755 "/opt/bun-linux-$bun_arch/bun" /usr/local/bin/bun \
  && rm -rf /tmp/bun.zip "/opt/bun-linux-$bun_arch"

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
  && rm -rf /root/.cua-driver \
  && rm -f /tmp/cua-install.sh

RUN groupadd --system cloud-swe \
  && useradd --create-home --shell /bin/bash --gid cloud-swe sandbox \
  && install -d -m 0755 -o sandbox -g cloud-swe /workspace \
  && install -d -m 0700 /var/lib/cloud-swe/repository \
  && usermod -aG cloud-swe sandbox \
  && usermod -aG docker sandbox \
  && runuser -u sandbox -- env HOME=/home/sandbox /usr/local/bin/cua-driver telemetry disable

COPY infra/freestyle/systemd/ /etc/systemd/system/
RUN chmod 0644 /etc/systemd/system/cloud-swe-*.service

WORKDIR /workspace
CMD ["/bin/bash", "-lc", "sleep infinity"]
