FROM ubuntu:24.04

ARG NODE_MAJOR=24
ARG BUN_VERSION=1.4.0
ARG PNPM_VERSION=10
ARG AGENT_BROWSER_VERSION=0.38.2

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
ENV BUN_INSTALL=/usr/local
# Guest commands run as root, where Chrome refuses to start with its sandbox.
ENV AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY capabilities.list install-toolchain.sh /tmp/cloud-swe/
RUN bash /tmp/cloud-swe/install-toolchain.sh && rm -rf /tmp/cloud-swe

RUN install -d -m 0775 /workspace \
  && install -d -m 0770 /var/lib/cloud-swe/repository

# Modal starts supervisord as the sandbox entrypoint. It owns Docker, and it
# restarts it after a restore from an exit snapshot.
COPY supervisord.conf /etc/supervisor/conf.d/cloud-swe.conf

WORKDIR /workspace
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
