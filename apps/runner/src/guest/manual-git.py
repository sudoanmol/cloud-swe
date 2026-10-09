"""Manual Git check and idempotent local commit, invoked through the coordinator."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

request = json.load(sys.stdin)

def git(*args, env=None):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', *args], stderr=subprocess.DEVNULL, timeout=30, env=env).decode().strip()

def excerpt(*args, limit):
    process = subprocess.Popen(['git', '-c', 'core.hooksPath=/dev/null', *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        value = process.stdout.read(limit + 1)
        return value[:limit].decode('utf-8', errors='replace')
    finally:
        process.kill()
        process.wait()

def snapshot(message):
    # Commit every change from a private index, so the real index and refs stay untouched.
    directory = tempfile.mkdtemp(prefix='cloud-swe-manual-')
    try:
        index = os.path.join(directory, 'index')
        source = git('rev-parse', '--git-path', 'index')
        if os.path.exists(source):
            shutil.copyfile(source, index)
        env = dict(os.environ, GIT_INDEX_FILE=index)
        git('add', '-A', env=env)
        tree = git('write-tree', env=env)
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    return subprocess.check_output(['git', 'commit-tree', tree, '-p', head], input=message.encode(), timeout=30).decode().strip()

branch = git('symbolic-ref', '--short', 'HEAD')
head = git('rev-parse', 'HEAD')
receipt = 'refs/cloud-swe/manual/' + request['runId']
if request['kind'] == 'commit':
    prior = subprocess.run(['git', 'rev-parse', '--verify', receipt], capture_output=True, timeout=10)
    if prior.returncode == 0:
        commit = prior.stdout.decode().strip()
        if head != commit:
            raise RuntimeError('Manual commit no longer matches branch')
        print(commit)
        sys.exit(0)

status = subprocess.check_output(['git', 'status', '--porcelain=v1', '-z'], timeout=30)
hash_value = hashlib.sha256(head.encode() + branch.encode() + status)
# Include staged content and all tracked/untracked changes, including symlink targets.
hash_value.update(git('write-tree').encode())
paths = subprocess.check_output(['git', 'ls-files', '-z', '--modified', '--others', '--exclude-standard'], timeout=30).split(b'\0')
remaining = 64 * 1024 * 1024
for raw in sorted(set(paths)):
    if not raw:
        continue
    path = os.fsdecode(raw)
    hash_value.update(raw)
    if os.path.islink(path):
        hash_value.update(os.fsencode(os.readlink(path)))
    elif os.path.isfile(path):
        with open(path, 'rb') as file:
            while chunk := file.read(65536):
                remaining -= len(chunk)
                if remaining < 0:
                    raise RuntimeError('Manual changes exceed 64 MiB')
                hash_value.update(chunk)
    else:
        hash_value.update(b'missing')
fingerprint = hash_value.hexdigest()
if request['kind'] == 'commit':
    if fingerprint != request['fingerprint']:
        raise RuntimeError('Workspace changed since the check')
    if not status:
        print(head)
        sys.exit(0)
    commit = snapshot(request['message'])
    # Branch update and receipt are atomic. A retry observes the receipt instead of committing again.
    subprocess.run(['git', 'update-ref', '--stdin'], input=f'start\nupdate refs/heads/{branch} {commit} {head}\ncreate {receipt} {commit}\nprepare\ncommit\n'.encode(), check=True, stdout=subprocess.DEVNULL, timeout=30)
    # The new commit holds exactly the working tree, so the index now matches it.
    subprocess.run(['git', 'reset', '--quiet'], check=True, timeout=30)
    print(commit)
else:
    ref = 'origin/' + request['base']
    exists = subprocess.run(['git', 'rev-parse', '--verify', ref], capture_output=True, timeout=10).returncode == 0
    compare = ref if exists else head
    commits = excerpt('log', '--format=%s', '-20', f'{ref}..HEAD' if exists else 'HEAD', limit=8000)
    if not commits.strip():
        commits = excerpt('log', '-1', '--format=%s', 'HEAD', limit=8000)
    diff = excerpt('diff', '--no-ext-diff', '--no-textconv', compare, limit=16000)
    untracked = subprocess.check_output(['git', 'ls-files', '-z', '--others', '--exclude-standard'], timeout=30).split(b'\0')
    for raw in untracked:
        if raw and len(diff) < 16000:
            diff += excerpt('diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', os.fsdecode(raw), limit=16000 - len(diff))
    stat = excerpt('diff', '--no-ext-diff', '--no-textconv', '--stat', compare, limit=7800)
    stat += f"\n{sum(bool(path) for path in untracked)} untracked files"
    commit = snapshot('Cloud SWE snapshot') if status else head
    changed = len([name for name in subprocess.check_output(['git', 'diff', '--name-only', '-z', head, commit], timeout=30).split(b'\0') if name])
    print(json.dumps(dict(branch=branch, head=head, commit=commit, dirty=bool(status), changedFiles=changed, fingerprint=fingerprint, commits=commits, stat=stat, diff=diff)))
