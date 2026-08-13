#!/bin/sh
set -e

# A freshly attached volume — on Fly, and with plain `docker run -v` — is owned
# by root, but the app runs unprivileged. Fix ownership on the data directory
# before dropping privileges. When the container is already running as a
# non-root user there is nothing to do but exec.
if [ "$(id -u)" = "0" ]; then
  DATA_DIR=$(dirname "${DB_PATH:-/data/jukebox.db}")
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec gosu node "$@"
fi

exec "$@"
