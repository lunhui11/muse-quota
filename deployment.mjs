import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const RUNTIME_FILES = Object.freeze([
  'deployment.mjs', 'drive.mjs', 'executor.mjs', 'muse.mjs', 'pool.mjs',
  'probe.mjs', 'server.mjs', 'package.json', 'package-lock.json', 'public/index.html',
]);

// Capture at service startup. Updating files on disk does not change this report
// until that process is deliberately restarted after its tasks have stopped.
export async function inspectDeployment(directory) {
  const root = await realpath(directory);
  const hashes = {};
  for (const name of RUNTIME_FILES) {
    try {
      const info = await lstat(join(root, name));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) continue;
      hashes[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    } catch {}
  }
  const complete = RUNTIME_FILES.every(name => hashes[name]);
  const runtimeHash = complete ? createHash('sha256').update(
    Object.keys(hashes).sort().map(name => name + '\0' + hashes[name] + '\n').join(''),
  ).digest('hex') : null;
  const result = {
    service_root: root, process_cwd: resolve(process.cwd()), process_id: process.pid,
    source_kind: 'unversioned_copy', source_commit: null, runtime_modified: null,
    bundle_declared_commit: null, manifest_runtime_verified: null,
    runtime_files_complete: complete, runtime_sha256: runtimeHash,
    captured_at: new Date().toISOString(),
  };
  try {
    const info = await lstat(join(root, 'HANDOFF-MANIFEST.json'));
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024) {
      const manifest = JSON.parse(await readFile(join(root, 'HANDOFF-MANIFEST.json'), 'utf8'));
      if (manifest.format === 1 && manifest.contains === 'source_only') {
        result.bundle_declared_commit = COMMIT.test(manifest.source_commit || '') ? manifest.source_commit : null;
        result.manifest_runtime_verified = complete && RUNTIME_FILES.every(name => manifest.files?.[name] === hashes[name]);
        if (result.manifest_runtime_verified) {
          result.source_kind = 'source_bundle';
          result.source_commit = result.bundle_declared_commit;
          result.runtime_modified = typeof manifest.source_modified === 'boolean' ? manifest.source_modified : null;
        }
      }
    }
  } catch {}
  try {
    // A parent repository does not make this copied service a Git checkout.
    await lstat(join(root, '.git'));
    const git = async args => (await run('git', ['-C', root, ...args], {
      timeout: 2000, maxBuffer: 128 * 1024, windowsHide: true,
    })).stdout.trim();
    if (await realpath(await git(['rev-parse', '--show-toplevel'])) === root) {
      const commit = await git(['rev-parse', '--verify', 'HEAD']);
      if (COMMIT.test(commit)) {
        result.source_kind = 'git_checkout';
        result.source_commit = commit;
        result.runtime_modified = !!await git(['status', '--porcelain', '--untracked-files=normal', '--', ...RUNTIME_FILES]);
      }
    }
  } catch {}
  return result;
}
