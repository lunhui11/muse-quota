#!/usr/bin/env python3
"""Render a reviewable unit; do not write /etc or enable a service."""
import argparse
from pathlib import Path
import re


def quoted(value):
    if any(c in value for c in '\n\r\0'):
        raise ValueError('Invalid path')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


p=argparse.ArgumentParser()
p.add_argument('--target',required=True,help='Directory created by install.sh')
p.add_argument('--user',required=True)
p.add_argument('--output',required=True)
a=p.parse_args()
if not re.fullmatch(r'[a-z_][a-z0-9_-]*\$?',a.user):
    raise SystemExit('Invalid service account name')
target=Path(a.target).resolve()
# Read only the non-secret data-directory selector. Never render credentials or message data.
data=None
for line in (target/'relay.env').read_text().splitlines():
    if line.startswith('WECHAT_MUSE_DATA_DIR='):
        data=line.partition('=')[2].strip().strip('\'"')
if not data or not Path(data).is_absolute():
    raise SystemExit('WECHAT_MUSE_DATA_DIR must be absolute')
unit=f'''[Unit]
Description=WeChat adapter for Muse account pool
After=network-online.target musegadget.service
Wants=network-online.target
Conflicts=wechat-muse-bridge.service
StartLimitIntervalSec=120
StartLimitBurst=3

[Service]
Type=simple
User={a.user}
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PYTHONUNBUFFERED=1
ExecStart={quoted(str(target/'venv/bin/muse-pool-wechat'))} run --env-file {quoted(str(target/'relay.env'))}
WorkingDirectory={str(target).replace('%', '%%')}
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths={quoted(data)}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
'''
Path(a.output).write_text(unit)
print('Rendered service unit: '+str(Path(a.output).resolve()))
