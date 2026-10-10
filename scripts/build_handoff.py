#!/usr/bin/env python3
"""Bundle reviewed source only. Credentials, accounts and dependency caches stay private."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
ROOT_FILES={'.gitignore','.dockerignore','.env.example','Dockerfile','compose.yaml','Start.ps1',
            'package.json','package-lock.json','README.md','design.md','implementation-plan.md','audit-report.md',
            'server.mjs','probe.mjs','drive.mjs','pool.mjs','muse.mjs','executor.mjs',
            'test.mjs','test-pool.mjs','test-pool-regressions.mjs','test-executor.mjs'}
BLOCKED={'data','work','node_modules','.git','.venv','venv','__pycache__','.pytest_cache'}
SUFFIXES={'.mjs','.py','.md','.sh','.toml','.service','.json','.example'}


def sources():
    selected=[]
    for entry in ROOT.iterdir():
        if entry.name in ROOT_FILES and entry.is_file():
            selected.append(entry)
    def walk(directory):
        if directory.is_symlink():
            raise ValueError('Refuse to bundle a symlink: '+str(directory.relative_to(ROOT)))
        for entry in directory.iterdir():
            if entry.name in BLOCKED or entry.name.startswith('.'):
                continue
            if entry.is_symlink():
                raise ValueError('Refuse to bundle a symlink: '+str(entry.relative_to(ROOT)))
            if entry.is_dir():walk(entry)
            elif entry.suffix in SUFFIXES:selected.append(entry)
    for name in ('public','docs','integrations','scripts'):
        directory=ROOT/name
        if directory.is_dir():walk(directory)
    # Include the static dashboard explicitly; do not include arbitrary runtime HTML exports.
    dashboard=ROOT/'public/index.html'
    if dashboard.is_file():selected.append(dashboard)
    for entry in selected:
        if entry.is_symlink() or ROOT not in entry.resolve().parents:
            raise ValueError('Refuse source path outside the project')
    return sorted(set(selected))


def build(output):
    files=sources()
    manifest={'format':1,'contains':'source_only','files':{}}
    output=Path(output).resolve()
    output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            relative=path.relative_to(ROOT).as_posix()
            content=path.read_bytes()
            if path.suffix == '.sh':
                content=content.replace(b'\r\n',b'\n')
            manifest['files'][relative]=hashlib.sha256(content).hexdigest()
            archive.writestr('muse-quota/'+relative,content)
        archive.writestr('muse-quota/HANDOFF-MANIFEST.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    digest=hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix+'.sha256').write_text(digest+'  '+output.name+'\n')
    print(json.dumps({'archive':str(output),'source_files':len(files),'sha256':digest},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',default=str(ROOT/'work/muse-quota-handoff.zip'))
    build(parser.parse_args().output)
