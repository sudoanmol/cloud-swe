import os, sys, json, stat, hashlib, tempfile, difflib

LIMIT = 1024 * 1024

class ToolFailure(ValueError):
    def __init__(self, code, count):
        self.result = dict(kind='project-tool-failure', version=1, code=code, matchCount=count)

def fail(message):
    raise ValueError(message)

def path_in_workspace(value):
    if not isinstance(value, str) or not value or '\x00' in value or '..' in value.split('/'):
        fail('Path must remain inside /workspace without traversal')
    path = value if value.startswith('/') else '/workspace/' + value
    path = os.path.realpath(path)
    if not path.startswith('/workspace/'):
        fail('Path must remain inside /workspace')
    return path

def text_bytes(value):
    data = value.encode('utf-8', errors='strict')
    if len(data) > LIMIT:
        fail('Text exceeds the 1 MiB limit')
    return data

def validate_text(data):
    if b'\x00' in data or any(b < 32 and b not in (9,10,13,12,8) for b in data):
        fail('Binary files are unsupported')
    return data.decode('utf-8', errors='strict')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def execute(request):
    path = path_in_workspace(request['path'])
    operation = request['operation']
    parent = os.path.dirname(path)
    if operation == 'write':
        os.makedirs(parent, exist_ok=True)
    # Resolve before opening; hold directory descriptors and refuse subsequent symlink substitutions.
    directory = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in os.path.relpath(parent, '/workspace').split('/'):
            if part == '.': continue
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        name = os.path.basename(path)
        before = b''
        info = None
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            if operation != 'write': raise
        else:
            with os.fdopen(fd, 'rb') as file:
                info = os.fstat(file.fileno())
                if not stat.S_ISREG(info.st_mode): fail('Only regular text files are supported')
                before = file.read(LIMIT + 1)
                if len(before) > LIMIT: fail('File exceeds the 1 MiB limit')
        old = validate_text(before)
        if operation == 'read':
            return old
        count = 0
        if operation == 'write':
            after = text_bytes(request['content'])
            validate_text(after)
        elif operation == 'edit':
            old_text = request['oldText']
            new_text = request['newText']
            if not old_text: fail('oldText must not be empty')
            if len(text_bytes(old_text)) + len(text_bytes(new_text)) > LIMIT:
                fail('Replacement input exceeds the 1 MiB limit')
            count = old.count(old_text)
            if count == 0: raise ToolFailure('no-literal-match', count)
            if count != 1 and not request.get('replaceAll', False): raise ToolFailure('ambiguous-literal-match', count)
            after = text_bytes(old.replace(old_text, new_text))
            validate_text(after)
        else:
            fail('Unknown file operation')
        new = after.decode('utf-8')
        diff_parts = []
        diff_bytes = 0
        truncated = False
        added = deleted = 0
        # Split with endings intact so CRLF and missing final newlines survive editing.
        lines = difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
            fromfile='a/' + path[len('/workspace/'):], tofile='b/' + path[len('/workspace/'):])
        for index, line in enumerate(lines):
            if index > 1:
                added += line.startswith('+')
                deleted += line.startswith('-')
            if not line.endswith('\n'):
                line += '\n\\ No newline at end of file\n'
            encoded = line.encode('utf-8')
            if diff_bytes + len(encoded) <= 65536 and not truncated:
                diff_parts.append(line)
                diff_bytes += len(encoded)
            else: truncated = True
        result = dict(version=1, path=path, replacementCount=count, unifiedDiff=''.join(diff_parts),
            additions=added, deletions=deleted, beforeHash=digest(before), afterHash=digest(after), diffTruncated=truncated)
        budget = request.get('outputMaxBytes', 262144)
        if budget < 1024: fail('Command output budget is too small for an edit result')
        while len(json.dumps(result, ensure_ascii=True).encode()) + 1 > budget:
            result['unifiedDiff'] = result['unifiedDiff'][:len(result['unifiedDiff']) // 2]
            result['diffTruncated'] = True
            if not result['unifiedDiff'] and len(json.dumps(result).encode()) + 1 > budget:
                fail('Command output budget is too small for this path')
        temporary = '.cloud-swe-edit-' + os.urandom(16).hex()
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, 'wb') as file:
                file.write(after)
                os.fchmod(file.fileno(), stat.S_IMODE(info.st_mode) if info else 0o644)
                os.fsync(file.fileno())
            if info:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                with os.fdopen(fd, 'rb') as current:
                    now = os.fstat(current.fileno())
                    if (now.st_ino, now.st_dev, now.st_mtime_ns, now.st_ctime_ns, now.st_size) != (info.st_ino, info.st_dev, info.st_mtime_ns, info.st_ctime_ns, info.st_size) or current.read(LIMIT + 1) != before:
                        fail('Target changed during replacement')
            elif os.path.lexists(path): fail('Target appeared during replacement')
            if path_in_workspace(request['path']) != path: fail('Target path changed during replacement')
            parent_now = os.stat(parent, follow_symlinks=False)
            held_parent = os.fstat(directory)
            if (parent_now.st_ino,parent_now.st_dev) != (held_parent.st_ino,held_parent.st_dev): fail('Target directory changed during replacement')
            os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            try: os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError: pass
        return json.dumps(result, ensure_ascii=True)
    finally:
        os.close(directory)

try:
    raw = sys.stdin.buffer.read(7 * LIMIT + 1)
    if len(raw) > 7 * LIMIT: fail('Request exceeds the input limit')
    result = execute(json.loads(raw))
    sys.stdout.write(result)
except ToolFailure as error:
    print(json.dumps(error.result), file=sys.stderr)
    sys.exit(1)
except (ValueError, KeyError, OSError, UnicodeError) as error:
    # Never return guest environment or system exception details.
    message = str(error) if type(error) is ValueError else 'File operation failed: unsupported path, encoding, or concurrent change'
    print(message, file=sys.stderr)
    sys.exit(1)
