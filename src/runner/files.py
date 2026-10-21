"""One-shot helper over an authenticated SSH channel, never a listening service."""
import base64, hashlib, json, os, pathlib, re, signal, stat, sys, tempfile, time

MAX_DIRECTORY_ENTRIES = 10000
MAX_DIRECTORY_NAME_BYTES = 8 * 1024 * 1024

class Failure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message

def fail(code, message):
    raise Failure(code, message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def path_in(root, relative, new=False):
    if not isinstance(relative, str) or '\0' in relative or relative.startswith('/') or '..' in pathlib.PurePosixPath(relative).parts:
        fail('INVALID_PATH', 'Expected a workspace-relative path without traversal')
    path = pathlib.Path(root)
    for part in pathlib.PurePosixPath(relative).parts:
        path = path / part
        if path.is_symlink():
            fail('INVALID_PATH', 'Symbolic links are not accepted by file tools')
    resolved = path.resolve(strict=not new)
    if os.path.commonpath([root, str(resolved)]) != root:
        fail('INVALID_PATH', 'Path escapes workspace')
    return resolved

def read_regular(path, limit=1048576):
    if not path.is_file() or not stat.S_ISREG(path.stat().st_mode):
        fail('INVALID_FILE', 'Only regular files are supported')
    # NOFOLLOW also closes the final-component symlink race.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            fail('INVALID_FILE', 'Only regular files are supported')
        data = f.read(limit + 1)
    if len(data) > limit:
        fail('FILE_TOO_LARGE', 'File exceeds configured operation limit')
    return data

def transfer_id(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix + r'_[a-f0-9-]{36}', value):
        fail('INVALID_TRANSFER', 'Invalid transfer ID')
    return value

def transfer_meta_path(directory, value):
    return pathlib.Path(directory) / (value + '.json')

def load_transfer(directory, value):
    path = transfer_meta_path(directory, value)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'r', encoding='utf-8') as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                fail('INVALID_TRANSFER', 'Transfer state is invalid')
            data = json.load(f)
    except FileNotFoundError:
        fail('TRANSFER_NOT_FOUND', 'Transfer state is unavailable')
    except (OSError, ValueError):
        fail('INVALID_TRANSFER', 'Transfer state is invalid')
    if data.get('id') != value:
        fail('INVALID_TRANSFER', 'Transfer state does not match')
    return data

def save_transfer(directory, data):
    fd, temporary = tempfile.mkstemp(prefix=data['id'] + '.pending.', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f); f.flush(); os.fsync(f.fileno())
        os.replace(temporary, transfer_meta_path(directory, data['id']))
        dirfd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try: os.fsync(dirfd)
        finally: os.close(dirfd)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def hash_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    digest, size = hashlib.sha256(), 0
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode): fail('INVALID_FILE', 'Only regular files are supported')
        while True:
            chunk = f.read(1048576)
            if not chunk: break
            size += len(chunk)
            if size > limit: fail('FILE_TOO_LARGE', 'File exceeds configured transfer limit')
            digest.update(chunk)
    return size, digest.hexdigest()

def main(a):
    op = a['op']
    if op == 'prepare':
        root = str(pathlib.Path(a['root']).resolve(strict=True))
        if not os.path.isdir(root): fail('INVALID_WORKSPACE', 'Workspace is not a directory')
        directory = tempfile.mkdtemp(prefix='shell-mcp-')
        return {'dir': directory, 'root': root}
    directory = a.get('dir')
    if directory is not None:
        p = pathlib.Path(directory)
        if not p.name.startswith('shell-mcp-') or str(p.parent) != tempfile.gettempdir() or p.is_symlink() or p.stat().st_uid != os.getuid():
            fail('INVALID_SESSION', 'Invalid private worker directory')
    if op == 'write_command':
        cid = a['commandId']
        if not cid.startswith('c_') or any(c not in 'c_abcdef0123456789-' for c in cid): fail('INVALID_COMMAND', 'Invalid command ID')
        fd = os.open(directory+'/'+cid+'.sh', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as f: f.write(base64.b64decode(a['content']))
        with open(directory+'/'+cid+'.mode', 'w') as f: f.write(a.get('inputMode', 'closed'))
        return {'ok': True}
    if op == 'input':
        cid, seq = a['commandId'], a['sequence']
        if os.path.exists(directory+'/'+cid+'.done'): fail('COMMAND_FINISHED', 'Command already finished')
        if open(directory+'/'+cid+'.mode').read() != 'pipe': fail('STDIN_DISABLED', 'Command has no input pipe')
        entry = {'inputId':a['inputId'], 'content':a['content'], 'end':a['end']}
        path = directory+'/'+cid+'.input.%08d'%seq
        if os.path.exists(path):
            if json.load(open(path)) != entry: fail('INPUT_CONFLICT', 'Input sequence is already occupied')
            return {'published':True}
        fd, temporary = tempfile.mkstemp(prefix=cid+'.pending.', dir=directory)
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump(entry,f); f.flush(); os.fsync(f.fileno())
            os.replace(temporary,path)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
        return {'published':True}
    if op == 'poll':
        cid, maximum = a['commandId'], a['maximum']
        result = {'done': None, 'streams': {}}
        for stream in ['stdout', 'stderr']:
            path = directory+'/'+cid+'.'+stream
            if os.path.exists(path):
                size = os.path.getsize(path)
                with open(path, 'rb') as f:
                    offset = a.get('offsets', {}).get(stream, 0)
                    f.seek(offset)
                    data = f.read(min(32768, max(0, maximum-offset)))
                result['streams'][stream] = {'base64': base64.b64encode(data).decode(), 'size': size, 'truncated': os.path.exists(path+'.truncated')}
        if os.path.exists(directory+'/'+cid+'.done'):
            with open(directory+'/'+cid+'.done') as f: result['done'] = json.load(f)
        return result
    if op == 'kill':
        with open(directory+'/identity') as f: identity = json.load(f)
        pid = identity['pid']
        try:
            start = open('/proc/%s/stat'%pid).read().rsplit(')',1)[1].split()[19]
            if start != identity['start'] or os.getpgid(pid) != pid: fail('PROCESS_CHANGED', 'Worker process identity changed')
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        except FileNotFoundError: pass
        for _ in range(20):
            try:
                fields = open('/proc/%s/stat'%pid).read().rsplit(')',1)[1].split()
                if fields[0] == 'Z' or fields[19] != identity['start']: break
            except FileNotFoundError: break
            time.sleep(0.05)
        else: return {'terminationConfirmed': False}
        return {'terminationConfirmed': True}
    if op == 'discard_command':
        for p in pathlib.Path(directory).glob(a['commandId']+'.*'):
            if not p.is_dir() or p.is_symlink(): p.unlink()
        return {'ok': True}
    if op == 'cleanup':
        # Delete only files created in our owned private spool; no recursive traversal.
        for p in pathlib.Path(directory).iterdir():
            if not p.is_dir() or p.is_symlink(): p.unlink()
        pathlib.Path(directory).rmdir()
        return {'ok': True}
    root = str(pathlib.Path(a['root']).resolve(strict=True))
    if op == 'search':
        start = path_in(root, a.get('path', '.'))
        excluded = {'.git', '.venv', 'node_modules', '__pycache__'}
        query = a['query'] if a.get('caseSensitive', True) else a['query'].lower()
        matches, reasons, scanned, total, skipped, seen = [], set(), 0, 0, 0, 0
        offset, maximum = a.get('cursor', 0), a.get('maximum', 50)
        candidates = []
        if start.is_file(): candidates = [start]
        elif start.is_dir():
            stack, directories, entries = [start], 0, 0
            stop = False
            while stack and not stop:
                parent = stack.pop()
                directories += 1
                try:
                    with os.scandir(parent) as listing:
                        for entry in listing:
                            entries += 1
                            if entries > 10000: reasons.add('entry_limit'); stop = True; break
                            if entry.is_symlink(): skipped += 1; continue
                            if entry.is_dir(follow_symlinks=False):
                                if entry.name in excluded: continue
                                if directories + len(stack) >= 1000:
                                    reasons.add('directory_limit'); continue
                                stack.append(pathlib.Path(entry.path))
                            else:
                                candidates.append(pathlib.Path(entry.path))
                                if len(candidates) >= 1000:
                                    reasons.add('file_limit'); stop = True; break
                except OSError: reasons.add('unreadable_directory')
                stack.sort(reverse=True)
            candidates.sort()
        else: fail('INVALID_PATH', 'Search path must be a file or directory')
        has_more = False
        for path in candidates:
            try:
                if path.is_symlink() or not path.is_file(): skipped += 1; continue
                size = path.stat().st_size
                if size > 1048576: skipped += 1; reasons.add('large_file'); continue
                if total + size > 10485760: reasons.add('byte_limit'); break
                data = read_regular(path); total += len(data); scanned += 1
                text = data.decode('utf-8')
                if '\0' in text: skipped += 1; continue
            except UnicodeError: skipped += 1; continue
            except Exception: skipped += 1; reasons.add('unreadable_file'); continue
            for number, line in enumerate(text.splitlines(), 1):
                haystack = line if a.get('caseSensitive', True) else line.lower()
                position = haystack.find(query)
                if position < 0: continue
                if len(haystack) != len(line):
                    lowered_offset = 0
                    for original_offset, character in enumerate(line):
                        lowered_offset += len(character.lower())
                        if position < lowered_offset:
                            position = original_offset; break
                if seen >= offset:
                    if len(matches) == maximum:
                        has_more = True; break
                    left = max(0, position-80)
                    matches.append({'path':str(path.relative_to(root)), 'line':number, 'column':position+1, 'snippet':line[left:left+300], 'snippetStartColumn':left+1})
                seen += 1
            if has_more: break
        return {'matches':matches, 'nextCursor':offset+len(matches) if has_more else None,
                'scannedFiles':scanned, 'scannedBytes':total, 'skippedFiles':skipped,
                'incomplete':bool(reasons), 'limitations':sorted(reasons), 'snapshot':False}
    if op == 'list':
        path = path_in(root, a.get('path', '.'))
        if not path.is_dir(): fail('INVALID_DIRECTORY', 'Expected a directory inside the workspace')
        names, name_bytes, limitations = [], 0, set()
        with os.scandir(path) as listing:
            for entry in listing:
                if len(names) >= MAX_DIRECTORY_ENTRIES:
                    limitations.add('entry_limit'); break
                encoded = os.fsencode(entry.name)
                if name_bytes + len(encoded) > MAX_DIRECTORY_NAME_BYTES:
                    limitations.add('name_bytes_limit'); break
                name_bytes += len(encoded)
                names.append(entry.name)
        names.sort()
        offset, maximum = a.get('offset', 0), a.get('maximum', 100)
        page = names[offset:offset+maximum]
        entries = []
        for name in page:
            try:
                info = os.lstat(path / name)
            except FileNotFoundError:
                limitations.add('entry_changed')
                continue
            mode = info.st_mode
            kind = ('symlink' if stat.S_ISLNK(mode) else 'directory' if stat.S_ISDIR(mode)
                    else 'file' if stat.S_ISREG(mode) else 'other')
            entries.append({'name':name,'type':kind,
                            'sizeBytes':info.st_size if stat.S_ISREG(mode) else None,
                            'modifiedAt':int(info.st_mtime * 1000),
                            'permissions':format(stat.S_IMODE(mode), '04o')})
        next_offset = offset + len(page)
        return {'entries':entries, 'nextCursor':next_offset if next_offset<len(names) else None,
                'scannedEntries':len(names), 'incomplete':bool(limitations),
                'limitations':sorted(limitations), 'snapshot':False}
    if op == 'upload_begin':
        transfer = transfer_id(a.get('transferId'), 'u')
        destination = path_in(root, a.get('path'), new=True)
        if destination == pathlib.Path(root): fail('INVALID_PATH', 'Cannot replace the workspace root')
        if not destination.parent.is_dir(): fail('INVALID_PATH', 'Parent directory must already exist')
        if isinstance(a.get('bytes'), bool) or not isinstance(a.get('bytes'), int) or a['bytes'] < 0:
            fail('INVALID_TRANSFER', 'Invalid upload size')
        maximum = a.get('maxBytes')
        if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 0:
            fail('INVALID_TRANSFER', 'Invalid upload limit')
        if a['bytes'] > maximum:
            fail('FILE_TOO_LARGE', 'Upload exceeds the configured transfer limit')
        if not re.fullmatch(r'[a-f0-9]{64}', a.get('sha256', '')):
            fail('INVALID_TRANSFER', 'Invalid upload checksum')
        metadata = transfer_meta_path(directory, transfer)
        if os.path.exists(metadata):
            record = load_transfer(directory, transfer)
            if (record.get('destination') != str(destination) or record.get('bytesExpected') != a['bytes']
                or record.get('sha256Expected') != a['sha256']):
                fail('TRANSFER_CONFLICT', 'Transfer ID was already used with different file metadata')
            return {'transferId':transfer, 'state':record['state'], 'bytes':record['received']}
        if os.path.lexists(destination): fail('FILE_EXISTS', 'Refusing to overwrite an existing workspace file')
        temporary = destination.parent / ('.shell-mcp-' + transfer + '.part')
        record = {'id':transfer, 'state':'uploading', 'destination':str(destination),
                  'temporary':str(temporary), 'bytesExpected':a['bytes'], 'sha256Expected':a['sha256'],
                  'received':0, 'nextSequence':0, 'lastSequence':None, 'lastChunkHash':None}
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            save_transfer(directory, record)
        except Exception:
            try: os.unlink(temporary)
            except FileNotFoundError: pass
            raise
        return {'transferId':transfer, 'state':'uploading', 'bytes':0}
    if op == 'upload_chunk':
        transfer = transfer_id(a.get('transferId'), 'u')
        record = load_transfer(directory, transfer)
        if record.get('state') == 'completed':
            return {'transferId':transfer, 'state':'completed', 'bytes':record['bytesExpected']}
        if record.get('state') != 'uploading': fail('TRANSFER_UNKNOWN', 'Upload state is uncertain')
        sequence = a.get('sequence')
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
            fail('INVALID_TRANSFER', 'Invalid upload sequence')
        try: chunk = base64.b64decode(a.get('content', ''), validate=True)
        except (ValueError, TypeError): fail('INVALID_DATA', 'Invalid upload chunk')
        if len(chunk) > 1048576 or not chunk: fail('INVALID_TRANSFER', 'Upload chunks must contain 1 to 1048576 bytes')
        chunk_hash = hashlib.sha256(chunk).hexdigest()
        temporary = pathlib.Path(record['temporary'])
        try:
            fd = os.open(temporary, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'r+b') as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): fail('INVALID_FILE', 'Upload staging file is invalid')
                f.seek(0, os.SEEK_END)
                if f.tell() != record['received']: fail('TRANSFER_UNKNOWN', 'Upload staging size does not match its confirmed state')
                if sequence == record['lastSequence']:
                    if chunk_hash != record['lastChunkHash'] or len(chunk) != record['lastChunkBytes']:
                        fail('TRANSFER_CONFLICT', 'Upload sequence was already used with different bytes')
                    return {'transferId':transfer, 'state':'uploading', 'sequence':sequence,
                            'bytes':record['received'], 'duplicate':True}
                if sequence != record['nextSequence']:
                    fail('TRANSFER_SEQUENCE', 'Upload chunk sequence is not the next expected value')
                if record['received'] + len(chunk) > record['bytesExpected']:
                    fail('TRANSFER_LIMIT', 'Upload exceeds its declared size')
                f.write(chunk); f.flush(); os.fsync(f.fileno())
        except FileNotFoundError: fail('TRANSFER_NOT_FOUND', 'Upload staging file is unavailable')
        record.update({'received':record['received'] + len(chunk), 'nextSequence':sequence + 1,
                       'lastSequence':sequence, 'lastChunkHash':chunk_hash, 'lastChunkBytes':len(chunk)})
        save_transfer(directory, record)
        return {'transferId':transfer, 'state':'uploading', 'sequence':sequence, 'bytes':record['received']}
    if op == 'upload_finish':
        transfer = transfer_id(a.get('transferId'), 'u')
        record = load_transfer(directory, transfer)
        if record.get('state') == 'completed':
            try: os.unlink(record['temporary'])
            except FileNotFoundError: pass
            return {'transferId':transfer, 'state':'completed', 'bytes':record['bytesExpected'], 'sha256':record['sha256Expected']}
        if record.get('state') not in ('uploading', 'publishing'):
            fail('TRANSFER_UNKNOWN', 'Upload state is uncertain')
        destination, temporary = pathlib.Path(record['destination']), pathlib.Path(record['temporary'])
        if record['received'] != record['bytesExpected']:
            fail('TRANSFER_INCOMPLETE', 'Uploaded byte count does not match the declared size')
        size, checksum = hash_regular(temporary, record['bytesExpected'])
        if size != record['bytesExpected'] or checksum != record['sha256Expected']:
            fail('TRANSFER_CHECKSUM', 'Uploaded bytes do not match the declared checksum')
        if os.path.lexists(destination):
            if record.get('state') == 'publishing':
                try:
                    source_info, published_info = os.stat(temporary, follow_symlinks=False), os.lstat(destination)
                    same_inode = (source_info.st_dev, source_info.st_ino) == (published_info.st_dev, published_info.st_ino)
                except FileNotFoundError:
                    same_inode = False
                if same_inode:
                    record['state'] = 'completed'; save_transfer(directory, record)
                    try: os.unlink(temporary)
                    except FileNotFoundError: pass
                    return {'transferId':transfer, 'state':'completed', 'bytes':size, 'sha256':checksum}
            fail('FILE_EXISTS', 'Refusing to overwrite an existing workspace file')
        if record.get('state') != 'publishing':
            record['state'] = 'publishing'; save_transfer(directory, record)
        try:
            os.link(temporary, destination, follow_symlinks=False)
        except FileExistsError:
            fail('FILE_EXISTS', 'Refusing to overwrite an existing workspace file')
        dirfd = os.open(destination.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try: os.fsync(dirfd)
        finally: os.close(dirfd)
        record['state'] = 'completed'; save_transfer(directory, record)
        try: os.unlink(temporary)
        except FileNotFoundError: pass
        return {'transferId':transfer, 'state':'completed', 'bytes':size, 'sha256':checksum}
    if op == 'upload_abort':
        transfer = transfer_id(a.get('transferId'), 'u')
        record = load_transfer(directory, transfer)
        if record.get('state') == 'completed':
            return {'transferId':transfer, 'state':'completed'}
        if record.get('state') == 'publishing':
            fail('TRANSFER_UNKNOWN', 'Upload publication is in progress; inspect the destination before retrying')
        try: os.unlink(record['temporary'])
        except FileNotFoundError: pass
        record['state'] = 'aborted'; save_transfer(directory, record)
        return {'transferId':transfer, 'state':'aborted'}
    if op == 'download_begin':
        transfer = transfer_id(a.get('transferId'), 'd')
        source = path_in(root, a.get('path'))
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        staged = pathlib.Path(directory) / (transfer + '.download')
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode): fail('INVALID_FILE', 'Only regular files can be downloaded')
            maximum = a.get('maxBytes')
            if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 0:
                fail('INVALID_TRANSFER', 'Invalid download limit')
            if before.st_size > maximum: fail('FILE_TOO_LARGE', 'Remote file exceeds the configured transfer limit')
            outfd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            checksum_state, total = hashlib.sha256(), 0
            with os.fdopen(fd, 'rb') as src, os.fdopen(outfd, 'wb') as out:
                while True:
                    chunk = src.read(1048576)
                    if not chunk: break
                    total += len(chunk)
                    if total > maximum: fail('FILE_TOO_LARGE', 'Remote file grew beyond the configured transfer limit')
                    checksum_state.update(chunk); out.write(chunk)
                out.flush(); os.fsync(out.fileno())
                after = os.fstat(src.fileno())
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or total != before.st_size:
                fail('SOURCE_CHANGED', 'Remote file changed while preparing the download')
            return {'transferId':transfer, 'bytes':total, 'sha256':checksum_state.hexdigest(),
                    'modifiedAt':int(before.st_mtime * 1000), 'filename':source.name}
        except Exception:
            try: os.unlink(staged)
            except FileNotFoundError: pass
            raise
        finally:
            try: os.close(fd)
            except OSError: pass
    if op == 'download_chunk':
        transfer = transfer_id(a.get('transferId'), 'd')
        offset, maximum = a.get('offset'), a.get('maximum')
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            fail('INVALID_CURSOR', 'Invalid download cursor')
        if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1 or maximum > 2097152:
            fail('INVALID_TRANSFER', 'Invalid download chunk size')
        path = pathlib.Path(directory) / (transfer + '.download')
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as f:
                info = os.fstat(f.fileno())
                if not stat.S_ISREG(info.st_mode): fail('INVALID_FILE', 'Download staging file is invalid')
                if offset > info.st_size: fail('INVALID_CURSOR', 'Download cursor exceeds file size')
                f.seek(offset); data = f.read(min(maximum, info.st_size - offset))
        except FileNotFoundError: fail('TRANSFER_NOT_FOUND', 'Download staging file is unavailable')
        return {'transferId':transfer, 'offset':offset, 'bytes':len(data), 'base64':base64.b64encode(data).decode('ascii')}
    if op == 'download_finish':
        transfer = transfer_id(a.get('transferId'), 'd')
        try: os.unlink(pathlib.Path(directory) / (transfer + '.download'))
        except FileNotFoundError: pass
        return {'transferId':transfer, 'state':'closed'}
    if op == 'read':
        path = path_in(root, a['path'])
        data = read_regular(path)
        text = data.decode('utf-8')
        if '\0' in text: fail('BINARY_FILE', 'Only UTF-8 text files are supported')
        return {'content':text, 'version':digest(data), 'bytes':len(data), 'encoding':'utf-8'}
    if op == 'apply':
        prepared = []
        for f in a['files']:
            path = path_in(root, f['path'], new=True)
            exists = path.exists()
            old = read_regular(path) if exists else None
            if (digest(old) if exists else None) != f['expectedVersion']:
                fail('VERSION_CONFLICT', 'File changed since it was read')
            if not path.parent.is_dir(): fail('INVALID_PATH', 'Parent directory must already exist')
            if f['path'] == '.': fail('INVALID_PATH', 'Cannot replace workspace root')
            prepared.append((path, f, old, path.stat().st_mode & 0o777 if exists else 0o600))
        applied = []
        try:
            for path, f, old, mode in prepared:
                # Best-effort recheck against outside editors, not a filesystem-wide CAS.
                current = read_regular(path) if path.exists() else None
                if current != old: fail('VERSION_CONFLICT', 'File changed during patch preparation')
                if f['content'] is None:
                    path.unlink()
                    version = None
                else:
                    data = base64.b64decode(f['content'])
                    fd, temporary = tempfile.mkstemp(prefix='.shell-mcp-', dir=path.parent)
                    try:
                        with os.fdopen(fd, 'wb') as out:
                            out.write(data); out.flush(); os.fsync(out.fileno())
                        os.chmod(temporary, mode)
                        os.replace(temporary, path)
                    finally:
                        if os.path.exists(temporary): os.unlink(temporary)
                    version = digest(data)
                applied.append({'path':f['path'], 'version':version})
        except Exception:
            if applied: return {'state':'partial_apply', 'files':applied, 'error':'Patch stopped; reread workspace before continuing'}
            raise
        return {'state':'applied', 'files':applied}
    fail('INVALID_OPERATION', 'Unknown helper operation')

try:
    print(json.dumps({'result':main(json.load(sys.stdin))}))
except Failure as e:
    print(json.dumps({'error':{'code':e.code,'message':e.message}}))
except (UnicodeError, ValueError):
    print(json.dumps({'error':{'code':'INVALID_DATA','message':'Invalid text or request data'}}))
except Exception:
    print(json.dumps({'error':{'code':'REMOTE_IO','message':'Remote file operation failed'}}))
