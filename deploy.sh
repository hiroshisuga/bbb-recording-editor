#!/bin/bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Accept the former editor selector for existing installation commands.
if [[ ${1:-} == --editor ]]; then
  shift
fi
exec python3 "$source_dir/editor/deploy/install-editor.py" "$@"
