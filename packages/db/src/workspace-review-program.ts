/**
 * Read-only guest program for the review panel and the live diff count. It runs
 * with argv only, never through a shell. Keep the Python free of backticks and
 * dollar-brace sequences so String.raw preserves it verbatim.
 */
export const workspaceReviewProgram = String.raw`import json, os, re, shutil, stat, subprocess, sys, tempfile

ROOT = '/workspace'
MAX_OUTPUT = 4 * 1024 * 1024
MAX_PATCH = 2 * 1024 * 1024
MAX_PATHS = 20000
MAX_FILE = 1024 * 1024
MAX_COMMITS = 200
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
SKIP = {'.git', 'node_modules', '.venv', 'dist', 'build', 'target', '__pycache__', '.next', '.turbo'}
DIFF = ['diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/']

class Failure(Exception):
    pass

def text(data):
    return data.decode('utf-8', 'replace')

def inert_config():
    # Reading the panel must not run repository-controlled programs: disable
    # hooks, fsmonitor and every configured filter driver for review commands.
    options = ['-c', 'core.quotepath=off', '-c', 'core.hooksPath=/dev/null',
               '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false']
    proc = subprocess.run(['git', 'config', '--name-only', '--get-regexp', r'^filter\.'],
                          cwd=ROOT, capture_output=True)
    for driver in sorted({key.rsplit('.', 1)[0] for key in text(proc.stdout).split()}):
        for name in ('clean', 'smudge', 'process'):
            options += ['-c', f'{driver}.{name}=']
        options += ['-c', f'{driver}.required=false']
    return options

INERT = []

def git(*args, env=None, check=True, limit=MAX_OUTPUT, partial=False):
    # Output is read with a bound; only callers that accept a prefix get one.
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(['git', '--no-optional-locks', *INERT, *args], cwd=ROOT,
                                stdout=subprocess.PIPE, stderr=errors, env=env)
        out = proc.stdout.read(limit + 1)
        if len(out) > limit:
            proc.kill()
        proc.stdout.close()
        proc.wait()
        if len(out) > limit:
            if partial:
                return out
            raise Failure('Git output exceeded the review limit')
        if proc.returncode != 0:
            if not check:
                return None
            errors.seek(0)
            raise Failure(text(errors.read(300)).strip() or 'git failed')
    return out

def is_repository():
    top = git('rev-parse', '--show-toplevel', check=False)
    return top is not None and os.path.realpath(text(top).strip()) == os.path.realpath(ROOT)

def commit(ref):
    out = git('rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}', check=False)
    return text(out).strip() if out else None

def base_ref(branch):
    # The clone's remote-tracking ref is the tip the thread started from.
    for ref in ([f'refs/remotes/origin/{branch}'] if branch else []) + ['refs/remotes/origin/HEAD']:
        if commit(ref):
            return ref
    return None

def short_name(ref):
    out = git('rev-parse', '--abbrev-ref', ref, check=False)
    return text(out).strip() if out else ref

def fork_point(ref):
    if not commit('HEAD'):
        return EMPTY_TREE
    if not ref:
        return 'HEAD'
    out = git('merge-base', 'HEAD', ref, check=False)
    return text(out).strip() if out else commit(ref)

def head_name():
    out = git('symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
    if out:
        return text(out).strip()
    return (commit('HEAD') or '')[:7] or None

def worktree_env(directory):
    # A private index with intent-to-add entries includes untracked files in
    # worktree diffs without staging anything or hashing their contents.
    index = os.path.join(directory, 'index')
    source = os.path.join(ROOT, text(git('rev-parse', '--git-path', 'index')).strip())
    if os.path.exists(source):
        shutil.copyfile(source, index)
    env = dict(os.environ, GIT_INDEX_FILE=index)
    git('add', '--all', '--intent-to-add', env=env)
    return env

def numstat(args, env):
    parts = text(git(*DIFF, '--numstat', '-z', *args, env=env)).split('\0')
    files, i = [], 0
    while i < len(parts) and parts[i]:
        added, deleted, path = parts[i].split('\t', 2)
        i += 1
        old = None
        if path == '':
            old, path = parts[i], parts[i + 1]
            i += 2
        binary = added == '-'
        files.append(dict(path=path, oldPath=old, binary=binary,
                          additions=0 if binary else int(added), deletions=0 if binary else int(deleted)))
    return files

def diff_args(branch, mode, sha):
    if mode == 'all':
        return [fork_point(base_ref(branch))], True
    if mode == 'uncommitted':
        return [commit('HEAD') or EMPTY_TREE], True
    if mode == 'commit':
        target = commit(sha)
        if not target:
            raise Failure('Unknown commit')
        parent = commit(target + '^')
        return [parent or EMPTY_TREE, target], False
    raise Failure('Unknown diff mode')

def with_diff(branch, mode, sha, work):
    args, worktree = diff_args(branch, mode, sha)
    if not worktree:
        return work(args, None)
    directory = tempfile.mkdtemp(prefix='cloud-swe-review-')
    try:
        return work(args, worktree_env(directory))
    finally:
        shutil.rmtree(directory, ignore_errors=True)

def diff_stat(branch):
    out = with_diff(branch, 'all', '', lambda args, env: git(*DIFF, '--shortstat', *args, env=env))
    counts = dict(files=0, additions=0, deletions=0)
    names = dict(file='files', insertion='additions', deletion='deletions')
    for count, word in re.findall(r'(\d+) (file|insertion|deletion)', text(out)):
        counts[names[word]] = int(count)
    return counts

def review(branch, mode, sha):
    def work(args, env):
        patch = git(*DIFF, *args, env=env, limit=MAX_PATCH, partial=True)
        return dict(files=numstat(args, env), patch=text(patch[:MAX_PATCH]),
                    patchTruncated=len(patch) > MAX_PATCH)
    return with_diff(branch, mode, sha, work)

def summary(branch):
    ref = base_ref(branch)
    commits = []
    if commit('HEAD'):
        target = 'HEAD' if not ref else f'{fork_point(ref)}..HEAD'
        out = text(git('log', '-z', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at',
                       f'--max-count={MAX_COMMITS + 1}', target))
        for record in filter(None, out.split('\0')):
            sha, short, subject, author, timestamp = record.split('\x1f')
            commits.append(dict(sha=sha, shortSha=short, subject=subject, author=author,
                                timestamp=int(timestamp)))
    return dict(head=head_name(), base=short_name(ref) if ref else None,
                commits=commits[:MAX_COMMITS], commitsTruncated=len(commits) > MAX_COMMITS)

def list_paths(repository):
    paths = set()
    if repository:
        out = git('ls-files', '-z', '--cached', '--others', '--exclude-standard', partial=True)
        entries = out[:MAX_OUTPUT].split(b'\0')
        # A cut listing ends inside a path; drop that fragment.
        for entry in entries[:-1] if len(out) > MAX_OUTPUT else entries:
            if entry and os.path.lexists(os.path.join(ROOT, text(entry))):
                paths.add(text(entry))
            if len(paths) > MAX_PATHS:
                break
    else:
        for directory, names, files in os.walk(ROOT):
            names[:] = [n for n in names if n not in SKIP]
            for name in files:
                paths.add(os.path.relpath(os.path.join(directory, name), ROOT))
                if len(paths) > MAX_PATHS:
                    break
            if len(paths) > MAX_PATHS:
                break
    ordered = sorted(paths)
    return dict(paths=ordered[:MAX_PATHS], truncated=len(ordered) > MAX_PATHS)

def read_file(path):
    parts = [part for part in path.split('/') if part not in ('', '.')]
    if not parts or '\0' in path or path.startswith('/') or '..' in parts:
        raise Failure('Path must be relative to the workspace')
    # Walk with directory descriptors and O_NOFOLLOW so a concurrent symlink
    # swap cannot redirect the read outside the workspace.
    directory = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                raise Failure('File not found')
            except OSError:
                raise Failure('Path must stay inside the workspace')
            os.close(directory)
            directory = child
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            raise Failure('File not found')
        except OSError:
            raise Failure('Not a regular file')
    finally:
        os.close(directory)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise Failure('Not a regular file')
        if info.st_size > MAX_FILE:
            return dict(path=path, size=info.st_size, kind='too-large')
        data = handle.read(MAX_FILE)
    if b'\0' in data[:8192]:
        return dict(path=path, size=info.st_size, kind='binary')
    return dict(path=path, size=info.st_size, kind='text', contents=text(data))

def listening_ports():
    # Listening TCP sockets from procfs: state 0A is LISTEN, the local port is hex.
    ports = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            with open(table) as handle:
                rows = handle.read().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            fields = row.split()
            if len(fields) > 3 and fields[3] == '0A':
                ports.add(int(fields[1].rsplit(':', 1)[1], 16))
    return sorted(ports)

def main():
    global INERT
    command, args = sys.argv[1], sys.argv[2:]
    if command == 'ports':
        return listening_ports()
    if not os.path.isdir(ROOT):
        raise Failure('Workspace directory is missing')
    if command == 'read':
        return read_file(args[0])
    INERT = inert_config()
    if command == 'files':
        return list_paths(is_repository())
    if not is_repository():
        return None
    if command == 'stat':
        return diff_stat(args[0])
    if command == 'summary':
        return summary(args[0])
    if command == 'review':
        return review(args[0], args[1], args[2] if len(args) > 2 else '')
    raise Failure('Unknown command')

try:
    result = dict(ok=True, result=main())
except Failure as error:
    result = dict(ok=False, error=str(error))
sys.stdout.write(json.dumps(result, ensure_ascii=False))`;
