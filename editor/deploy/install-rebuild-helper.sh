#!/bin/bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
  echo 'Run this installer as root (sudo bash editor/deploy/install-rebuild-helper.sh).' >&2
  exit 1
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for executable in /usr/bin/python3 /usr/bin/ruby /usr/bin/sudo /usr/sbin/visudo /usr/bin/bbb-record; do
  if [[ ! -x "$executable" ]]; then
    echo "Required executable is missing: $executable" >&2
    exit 1
  fi
done
/usr/sbin/visudo -cf "$source_dir/bbb-recording-editor.sudoers"
/usr/bin/ruby -rnokogiri -e 'abort "Ruby 3.0+ required" if RUBY_VERSION.to_f < 3'
/usr/bin/python3 - "$source_dir" <<'PYTHON'
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile

source = Path(sys.argv[1])
env_path = Path('/etc/bbb-recording-editor.env')
settings = {}
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if not match:
            raise ValueError('Unsupported environment-file syntax.')
        settings[match[1]] = ' '.join(shlex.split(match[2]))
raw = settings.get('BBB_EDITOR_RAW_ROOT', '/var/bigbluebutton/recording/raw')
state = settings.get('BBB_EDITOR_STATE_ROOT', '/var/lib/bbb-recording-editor')
process = settings.get('BBB_EDITOR_PROCESS_ROOT', str(Path(raw).parent / 'process/presentation'))
for value in [raw, state, process]:
    if not Path(value).is_absolute() or '\n' in value or '\r' in value:
        raise ValueError('Recording/state directories must be absolute paths.')
helper = (source / 'bbb-recording-editor-rebuild').read_text()
helper = helper.replace("RAW_ROOT = Path('/var/bigbluebutton/recording/raw')", f'RAW_ROOT = Path({raw!r})')
hook = (source / '00_recording_editor_title.rb').read_text()
ruby_string = lambda value: "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"
for key, default, value in [('RAW_ROOT', '/var/bigbluebutton/recording/raw', raw),
                            ('STATE_ROOT', '/var/lib/bbb-recording-editor', state),
                            ('PROCESS_ROOT', '/var/bigbluebutton/recording/process/presentation', process)]:
    expected = f"{key} = '{default}'"
    if expected not in hook:
        raise ValueError('Unexpected title hook template.')
    hook = hook.replace(expected, f'{key} = {ruby_string(value)}')
for destination, text in [('/usr/local/sbin/bbb-recording-editor-rebuild', helper),
                          ('/usr/local/bigbluebutton/core/scripts/post_process/00_recording_editor_title.rb', hook),
                          ('/usr/local/bigbluebutton/core/scripts/post_publish/00_recording_editor_title.rb', hook)]:
    path = Path(destination)
    if path.is_symlink():
        raise ValueError('Managed path must not be a symbolic link.')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            file.write(text)
        os.chown(temporary, 0, 0)
        os.chmod(temporary, 0o755)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
PYTHON
install -o root -g root -m 0440 "$source_dir/bbb-recording-editor.sudoers" /etc/sudoers.d/bbb-recording-editor
install -d -o root -g root -m 0755 /etc/systemd/system/bbb-recording-editor.service.d
install -o root -g root -m 0644 "$source_dir/rebuild.conf" /etc/systemd/system/bbb-recording-editor.service.d/rebuild.conf
/usr/sbin/visudo -cf /etc/sudoers
systemctl daemon-reload
systemctl restart bbb-recording-editor
echo 'Rebuild helper and recording-title hook installed. Reload the recording editor in your browser.'
