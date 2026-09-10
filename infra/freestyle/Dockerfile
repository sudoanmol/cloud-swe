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

# The same toolchain installer runs here and in the Freestyle golden VM.
# VM users and systemd desktop services remain in bootstrap.sh.
COPY infra/freestyle/capabilities.list infra/freestyle/install-toolchain.sh /tmp/cloud-swe/
RUN bash /tmp/cloud-swe/install-toolchain.sh && rm -rf /tmp/cloud-swe

RUN install -d -m 0775 /workspace
WORKDIR /workspace
CMD ["/bin/bash", "-lc", "sleep infinity"]
