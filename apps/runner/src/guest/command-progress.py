import os, sys, json, base64, stat

ROOT = '/tmp/cloud-swe-commands'
MAX_REQUEST = 65536
MAX_METADATA = 8192
MAX_STATE = 64

NOFOLLOW = os.O_RDONLY | os.O_NOFOLLOW


def fail(message):
    raise ValueError(message)


def open_child_dir(parent_fd, name):
    if not isinstance(name, str) or name in ('', '.', '..') or '/' in name or '\x00' in name:
        fail('Unsafe journal segment')
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)


def read_bounded(fd, limit):
    """Read at most limit bytes, reporting whether the source was longer."""
    data = b''
    while len(data) <= limit:
        chunk = os.read(fd, limit + 1 - len(data))
        if not chunk:
            break
        data += chunk
    return data[:limit], len(data) > limit


def read_regular(directory_fd, name, limit):
    """Bounded read of a regular file by descriptor, refusing symlinks."""
    fd = os.open(name, NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail('Journal entry is not a regular file')
        data, overflow = read_bounded(fd, limit)
        if overflow:
            fail('Journal entry exceeds its bounded size')
        return data
    finally:
        os.close(fd)


def capture_state(directory_fd, name):
    """Size of one live capture file, or 0 when it does not exist yet."""
    try:
        fd = os.open(name, NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    except FileNotFoundError:
        return 0
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail('Live capture is not a regular file')
        return info.st_size
    finally:
        os.close(fd)


def read_capture(directory_fd, name, offset, limit):
    fd = os.open(name, NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail('Live capture is not a regular file')
        if offset >= info.st_size:
            return b''
        os.lseek(fd, offset, os.SEEK_SET)
        data, _ = read_bounded(fd, limit)
        return data
    finally:
        os.close(fd)


def main():
    request = json.loads(sys.stdin.buffer.read(MAX_REQUEST + 1))
    command_id = request['commandId']
    marker = '__CLOUD_SWE_RESULT__' + command_id
    begin = '__CLOUD_SWE_PROGRESS__' + command_id + ':'
    end = '__CLOUD_SWE_PROGRESS__END:' + command_id + ':'

    def unavailable():
        sys.stdout.write('%s\tunknown\t\t0\t0\t0\t0\n' % marker)

    root_fd = None
    directory_fd = None
    try:
        # The journal is ROOT/<workspaceId>/<commandId>. Walk only validated
        # directory components; every open refuses symlinks so a substituted
        # journal cannot redirect a read outside its own command directory.
        root_fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        workspace_fd = open_child_dir(root_fd, request['workspaceId'])
        try:
            directory_fd = open_child_dir(workspace_fd, request['commandId'])
        finally:
            os.close(workspace_fd)
        metadata = read_regular(directory_fd, 'metadata', MAX_METADATA)
        if metadata != request['metadata'].encode('utf-8'):
            return unavailable()
        state = read_regular(directory_fd, 'state', MAX_STATE).decode('utf-8', 'strict').strip()
        if state not in ('pending', 'running', 'completed', 'failed'):
            return unavailable()
        sizes = {
            'stdout': capture_state(directory_fd, 'stdout.capture'),
            'stderr': capture_state(directory_fd, 'stderr.capture'),
        }
        sys.stdout.write('%s\t%s\t\t0\t0\t%d\t%d\n' % (
            marker, state, sizes['stdout'], sizes['stderr']))
        for stream in ('stdout', 'stderr'):
            offset = int(request['offset'][stream])
            limit = int(request['limit'][stream])
            if limit <= 0 or sizes[stream] <= offset:
                continue
            data = read_capture(directory_fd, stream + '.capture', offset, limit)
            if not data:
                continue
            sys.stdout.write(begin + stream + ':' + str(offset) + '\n')
            sys.stdout.write(base64.b64encode(data).decode('ascii') + '\n')
            sys.stdout.write(end + stream + '\n')
    except (ValueError, KeyError, OSError, UnicodeError):
        return unavailable()
    finally:
        for fd in (directory_fd, root_fd):
            if fd is not None:
                os.close(fd)


try:
    main()
except Exception:
    # Progress observation never produces a guest failure the runner could
    # mistake for a command outcome.
    sys.stdout.write('unknown\n')
