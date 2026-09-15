#!/bin/sh

set -eu

if [ "$#" -lt 1 ]; then
  echo "Purr dev runner expected a Cargo command or compiled application path." >&2
  exit 2
fi

# Tauri's --runner replaces Cargo, rather than receiving the final executable.
# Delegate the build to Cargo while installing this same script as Cargo's target
# runner; the second invocation then receives the freshly built binary path.
if [ "$1" = "run" ]; then
  purr_dev_host=$(rustc -vV | sed -n 's/^host: //p')
  purr_dev_runner_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  exec cargo \
    --config "target.${purr_dev_host}.runner=\"${purr_dev_runner_dir}/tauri-dev-runner.sh\"" \
    "$@"
fi

purr_dev_binary=$1
shift
purr_dev_identity=${PURR_DEV_SIGNING_IDENTITY:-}
if [ -z "$purr_dev_identity" ]; then
  purr_dev_identity=-
fi

/usr/bin/codesign \
  --force \
  --sign "$purr_dev_identity" \
  --identifier com.ihorpolishchuk.purr \
  --timestamp=none \
  "$purr_dev_binary"

exec "$purr_dev_binary" "$@"
