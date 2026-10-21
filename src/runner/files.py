"""One-shot helper over an authenticated SSH channel, never a listening service."""
import base64, hashlib, json, os, pathlib, signal, stat, sys, tempfile, time

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
        names = sorted(path.iterdir(), key=lambda p:p.name)
        offset, maximum = a.get('offset', 0), a.get('maximum', 100)
        page = names[offset:offset+maximum]
        return {'entries': [{'name':p.name,'type':'symlink' if p.is_symlink() else 'directory' if p.is_dir() else 'file'} for p in page], 'nextCursor':offset+len(page) if offset+len(page)<len(names) else None}
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
