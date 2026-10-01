FROM ubuntu:24.04

ARG NODE_MAJOR=24
ARG BUN_VERSION=1.4.0
ARG PNPM_VERSION=10
ARG CUA_DRIVER_VERSION=0.24.0

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
ENV BUN_INSTALL=/usr/local

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY capabilities.list install-toolchain.sh /tmp/cloud-swe/
RUN bash /tmp/cloud-swe/install-toolchain.sh && rm -rf /tmp/cloud-swe

# The desktop runs as `sandbox`. Guest commands run as root.
RUN groupadd --system cloud-swe \
  && useradd --create-home --shell /bin/bash --gid cloud-swe --groups docker sandbox \
  && runuser -u sandbox -- env HOME=/home/sandbox /usr/local/bin/cua-driver telemetry disable \
  && install -d -m 0775 -g cloud-swe /workspace \
  && install -d -m 0770 -g cloud-swe /var/lib/cloud-swe/repository

# Modal starts supervisord as the sandbox entrypoint. It owns Docker and the
# desktop services, and it restarts them after a restore from an exit snapshot.
COPY supervisord.conf /etc/supervisor/conf.d/cloud-swe.conf

WORKDIR /workspace
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
