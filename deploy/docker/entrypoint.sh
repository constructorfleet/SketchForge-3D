#!/bin/sh
# Container entrypoint. The server runs as the unprivileged `node` user, but
# the directories it stores projects in are whatever SKETCHFORGE_SHARED_PROJECTS_DIR
# and SKETCHFORGE_PROJECTS_DIR name, and Docker creates the mount point of a
# fresh volume owned by root whenever that path does not already exist in the
# image. So the container starts as root, creates the configured directories,
# hands each one to `node`, and only then drops privileges for the server.
#
# Started without root (`docker run --user ...`, rootless Docker, or a platform
# that forbids root containers) it cannot change ownership; it still creates
# what it can, warns about any directory the server will not be able to write,
# and starts the server as the current user.
set -eu

run_as_root() { [ "$(id -u)" = "0" ]; }

prepare() {
  dir="$1"
  [ -n "$dir" ] || return 0
  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "sketchforge: cannot create storage directory $dir (uid $(id -u)); saves there will fail" >&2
    return 0
  fi
  if run_as_root; then
    # Only the directory itself: it is the mount point Docker left root-owned.
    # Files below it were written by the server as `node` and already belong
    # to it; a recursive chown over a large library at every start is not worth it.
    chown node:node "$dir" || echo "sketchforge: cannot chown $dir to node" >&2
    if ! su-exec node test -w "$dir"; then
      echo "sketchforge: $dir is not writable by node (uid 1000); saves there will fail" >&2
    fi
  elif ! test -w "$dir"; then
    echo "sketchforge: $dir is not writable by uid $(id -u); saves there will fail" >&2
  fi
}

prepare "${SKETCHFORGE_SHARED_PROJECTS_DIR:-}"
prepare "${SKETCHFORGE_PROJECTS_DIR:-}"

if run_as_root; then
  exec su-exec node "$@"
fi
exec "$@"
