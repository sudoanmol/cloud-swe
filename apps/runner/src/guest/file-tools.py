import os, sys, json, stat, hashlib, tempfile, difflib

LIMIT = 1024 * 1024

ROOTS = ('/workspace', '/tmp')

class ToolFailure(ValueError):
    def __init__(self, code, index, count):
        self.result = dict(kind='project-tool-failure', version=2, code=code, editIndex=index, matchCount=count)

def fail(message):
    raise ValueError(message)

def resolve_path(value):
    if not isinstance(value, str) or not value or '\x00' in value or '..' in value.split('/'):
        fail('Path must be under /workspace or /tmp without traversal')
    path = value if value.startswith('/') else '/workspace/' + value
    path = os.path.realpath(path)
    for root in ROOTS:
        if path.startswith(root + '/'):
            return root, path
    fail('Path must be under /workspace or /tmp')

def text_bytes(value):
    data = value.encode('utf-8', errors='strict')
    if len(data) > LIMIT:
        fail('Text exceeds the 1 MiB limit')
    return data

def validate_text(data):
    if b'\x00' in data or any(b < 32 and b not in (9,10,13,12,8) for b in data):
        fail('Binary files are unsupported')
    return data.decode('utf-8', errors='strict')

READ_MAX_LINES = 2000
READ_MAX_BYTES = 50 * 1024

def read_window(text, offset, limit, path):
    # Mirrors Pi's read tool: 1-indexed offset, optional line limit, and a head
    # truncated to READ_MAX_LINES or READ_MAX_BYTES with a continuation notice.
    lines = text.split('\n')
    total = len(lines)
    start = max(0, offset - 1) if offset else 0
    if start >= total:
        fail(f'Offset {offset} is beyond end of file ({total} lines total)')
    end = min(start + limit, total) if limit is not None else total
    selected = []
    size = 0
    by_bytes = False
    for line in lines[start:end]:
        line_bytes = len(line.encode('utf-8')) + (1 if selected else 0)
        if len(selected) == READ_MAX_LINES:
            break
        if size + line_bytes > READ_MAX_BYTES:
            by_bytes = True
            break
        selected.append(line)
        size += line_bytes
    first = start + 1
    if not selected and by_bytes:
        return f"[Line {first} exceeds the {READ_MAX_BYTES // 1024}KB limit. Use bash: sed -n '{first}p' {path} | head -c {READ_MAX_BYTES}]"
    last = start + len(selected)
    content = '\n'.join(selected)
    if last < end:
        limit_note = f' ({READ_MAX_BYTES // 1024}KB limit)' if by_bytes else ''
        return f'{content}\n\n[Showing lines {first}-{last} of {total}{limit_note}. Use offset={last + 1} to continue.]'
    if end < total:
        return f'{content}\n\n[{total - end} more lines in file. Use offset={end + 1} to continue.]'
    return content

def digest(data):
    return hashlib.sha256(data).hexdigest()

def execute(request):
    root, path = resolve_path(request['path'])
    operation = request['operation']
    parent = os.path.dirname(path)
    if operation == 'write':
        os.makedirs(parent, exist_ok=True)
    # Resolve before opening; hold directory descriptors and refuse subsequent symlink substitutions.
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in os.path.relpath(parent, root).split('/'):
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
            return read_window(old, request.get('offset'), request.get('limit'), request['path'])
        count = 0
        if operation == 'write':
            after = text_bytes(request['content'])
            validate_text(after)
        elif operation == 'edit':
            edits = request['edits']
            if not isinstance(edits, list) or not edits: fail('edits must contain at least one replacement')
            if sum(len(text_bytes(edit['oldText'])) + len(text_bytes(edit['newText'])) for edit in edits) > LIMIT:
                fail('Replacement input exceeds the 1 MiB limit')
            # Every edit matches the original text, so earlier edits cannot shift later ones.
            matches = []
            for index, edit in enumerate(edits):
                if not edit['oldText']: fail(f'edits[{index}].oldText must not be empty')
                count = old.count(edit['oldText'])
                if count == 0: raise ToolFailure('no-literal-match', index, count)
                if count > 1: raise ToolFailure('ambiguous-literal-match', index, count)
                matches.append((old.index(edit['oldText']), index, edit))
            matches.sort(key=lambda match: match[0])
            for (start, index, edit), (next_start, next_index, _) in zip(matches, matches[1:]):
                if start + len(edit['oldText']) > next_start:
                    fail(f'edits[{index}] and edits[{next_index}] overlap. Merge them into one edit or target disjoint regions.')
            new_text = old
            for start, _, edit in reversed(matches):
                new_text = new_text[:start] + edit['newText'] + new_text[start + len(edit['oldText']):]
            if new_text == old: fail('No changes made. The replacements produced identical content.')
            count = len(edits)
            after = text_bytes(new_text)
            validate_text(after)
        else:
            fail('Unknown file operation')
        new = after.decode('utf-8')
        budget = request.get('outputMaxBytes', 262144)
        if operation == 'write':
            # `change` comes from the descriptor actually opened; an existing
            # empty file is a replacement, not a creation.
            result = dict(kind='write', path=path, change=('replaced' if info else 'created'),
                bytes=len(after), preview=new[:8192], previewBytes=len(new[:8192].encode('utf-8')),
                previewTruncated=len(new) > 8192)
            if len(json.dumps(result, ensure_ascii=True).encode()) + 1 > budget:
                fail('Command output budget is too small for a write result')
        else:
            diff_parts = []
            diff_bytes = 0
            truncated = False
            added = deleted = 0
            # Split with endings intact so CRLF and missing final newlines survive editing.
            label = os.path.relpath(path, '/workspace') if root == '/workspace' else path[1:]
            lines = difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
                fromfile='a/' + label, tofile='b/' + label)
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
            result = dict(kind='edit', version=1, path=path, replacementCount=count, unifiedDiff=''.join(diff_parts),
                additions=added, deletions=deleted, beforeHash=digest(before), afterHash=digest(after), diffTruncated=truncated)
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
            if resolve_path(request['path'])[1] != path: fail('Target path changed during replacement')
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
