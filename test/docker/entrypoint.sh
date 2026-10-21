#!/bin/sh
set -eu
if [ ! -s /run/demo-keys/host ] || [ ! -s /run/demo-keys/client.pub ]; then
    echo 'Missing private demo key mount' >&2
    exit 1
fi
if [ ! -d /workspace/project/.git ]; then
    su developer -c 'cd /workspace/project && git init -q && git -c user.name="MCP Demo" -c user.email="demo@example.invalid" add . && git -c user.name="MCP Demo" -c user.email="demo@example.invalid" commit -qm baseline'
fi
exec /usr/sbin/sshd -D -e
