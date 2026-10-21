FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server git util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash developer \
    && passwd -d developer \
    && mkdir -p /run/sshd /workspace/project /run/demo-keys \
    && chown -R developer:developer /workspace
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/demo-entrypoint
COPY project/ /workspace/project/
RUN chmod 755 /usr/local/bin/demo-entrypoint \
    && chown -R developer:developer /workspace/project
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/demo-entrypoint"]
