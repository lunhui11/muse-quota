#!/usr/bin/env bash
set -euo pipefail
# Installs a local, isolated optional adapter. No login, no service enablement, no Git push.
relay_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
relay_repo=$(cd -- "$relay_source/../.." && pwd)
relay_target=${1:-"$relay_repo/work/wechat"}
relay_ref=840f3fbfec7971f1f7c85a7e3910feacd2d2593e
umask 077
mkdir -p -- "$relay_target"
relay_target=$(cd -- "$relay_target" && pwd)
if [[ ! -d "$relay_target/upstream" ]]; then
  git clone https://github.com/huangzuomin/wechat-muse-bridge.git "$relay_target/upstream"
  git -C "$relay_target/upstream" checkout --detach "$relay_ref"
fi
if [[ "$(git -C "$relay_target/upstream" rev-parse HEAD)" != "$relay_ref" ]]; then
  echo "Existing upstream checkout differs from the reviewed commit; leave it intact and choose a new target." >&2
  exit 1
fi
if ! git -C "$relay_target/upstream" diff --quiet HEAD --; then
  echo "Existing upstream has local changes; preserve them and choose a new target." >&2
  exit 1
fi
python3 -m venv "$relay_target/venv"
"$relay_target/venv/bin/python" -m pip install "$relay_target/upstream"
"$relay_target/venv/bin/python" -m pip install "$relay_source[dev]"
if [[ ! -e "$relay_target/relay.env" ]]; then
  "$relay_target/venv/bin/python" - "$relay_source/relay.env.example" "$relay_target" <<'PY'
from pathlib import Path
import sys
source, target = Path(sys.argv[1]), Path(sys.argv[2])
content = source.read_text().replace('/path/to/private/wechat-data', str(target / 'data'))
(target / 'relay.env').write_text(content)
(target / 'relay.env').chmod(0o600)
(target / 'data').mkdir(mode=0o700)
PY
fi
"$relay_target/venv/bin/python" -m pytest "$relay_source/tests" -q
printf 'Installed optional adapter at %s\nConfig: %s\n' "$relay_target" "$relay_target/relay.env"
echo "Run doctor, then enroll --save-user. Start the service only after real login and pool setup."
