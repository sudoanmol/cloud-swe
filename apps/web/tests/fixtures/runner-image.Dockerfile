# Browser-suite sandbox: the shared local test image plus a real, offline Git
# origin. The guest rewrites the fixture repository URL to a local bare repo, so
# `prepareWorkspace` performs a genuine clone with no network access.
FROM cloud-swe-local-tests:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global --add safe.directory '*' \
 && install -d -m 0755 /opt/fixture-src /var/lib/cloud-swe \
 && cd /opt/fixture-src \
 && git init --quiet --initial-branch=main \
 && printf 'fixture\n' > README.md \
 && git add README.md \
 && git -c user.email=fixture@example.com -c user.name=fixture commit --quiet -m "fixture readme" \
 && git clone --quiet --bare /opt/fixture-src /opt/fixture-repo.git \
 && git -C /opt/fixture-repo.git symbolic-ref HEAD refs/heads/main \
 && cd / \
 && rm -rf /opt/fixture-src \
 && printf '[safe]\n\tdirectory = *\n[url "file:///opt/fixture-repo.git"]\n\tinsteadOf = https://github.com/fixture-org/fixture-repo.git\n' > /var/lib/cloud-swe/git.config \
 && chmod 0644 /var/lib/cloud-swe/git.config \
 && GIT_CONFIG_GLOBAL=/var/lib/cloud-swe/git.config git clone --quiet --branch main https://github.com/fixture-org/fixture-repo.git /tmp/clone-check \
 && test -f /tmp/clone-check/README.md \
 && rm -rf /tmp/clone-check
