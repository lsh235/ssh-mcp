"""Run one command under a remote controlling PTY and relay MCP input/output."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def process_start(pid):
    try:
        fields = open('/proc/%s/stat' % pid).read().rsplit(')', 1)[1].split()
        return fields[19]
    except (OSError, IndexError):
        return None


def save_identity(directory, command_id, pid):
    path = os.path.join(directory, '.pty-' + command_id + '.identity')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as target:
            json.dump({'pid': pid, 'start': process_start(pid)}, target)
            target.flush()
            os.fsync(target.fileno())
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def signal_group(pid, sig):
    try:
        fields = open('/proc/%s/stat' % pid).read().rsplit(')', 1)[1].split()
        if fields[19] == CHILD_START and int(fields[2]) == pid:
            os.killpg(pid, sig)
    except (OSError, ValueError, IndexError):
        pass


def resize(master, rows, columns):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))


def main():
    if len(sys.argv) != 6:
        return 64
    directory, command_id, rows_text, columns_text, command = sys.argv[1:]
    rows, columns = int(rows_text), int(columns_text)
    master, slave = pty.openpty()
    resize(slave, rows, columns)
    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            if slave > 2:
                os.close(slave)
            environment = os.environ.copy()
            environment['TERM'] = environment.get('TERM') or 'xterm-256color'
            os.execvpe('/bin/bash', ['bash', '--noprofile', '--norc', '-c', command], environment)
        except BaseException as error:
            os.write(2, ('PTY start failed: %s\r\n' % error).encode('utf-8', 'replace'))
            os._exit(127)
    os.close(slave)
    global CHILD_START
    CHILD_START = process_start(pid)
    identity_path = None
    pending = bytearray()
    incoming = bytearray()
    input_eof = False
    close_deadline = None
    child_status = None
    child_exit_time = None
    master_eof = False
    try:
        identity_path = save_identity(directory, command_id, pid)
        os.set_blocking(0, False)
        os.set_blocking(master, False)
        while True:
            if child_status is None:
                try:
                    waited, status = os.waitpid(pid, os.WNOHANG)
                    if waited:
                        child_status = status
                        child_exit_time = time.monotonic()
                        if close_deadline is None:
                            signal_group(pid, signal.SIGHUP)
                            close_deadline = child_exit_time + 0.5
                except ChildProcessError:
                    child_status = 0
                    child_exit_time = time.monotonic()
            now = time.monotonic()
            if close_deadline is not None and now >= close_deadline:
                signal_group(pid, signal.SIGKILL)
                close_deadline = None
            if child_status is not None and (master_eof or now - child_exit_time > 2):
                break
            readable = []
            if not input_eof and not close_deadline and child_status is None:
                readable.append(0)
            if not master_eof:
                readable.append(master)
            writable = [master] if pending and child_status is None else []
            try:
                ready_read, ready_write, _ = select.select(readable, writable, [], 0.05)
            except InterruptedError:
                continue
            if 0 in ready_read:
                try:
                    chunk = os.read(0, 65536)
                except BlockingIOError:
                    chunk = None
                if chunk == b'':
                    input_eof = True
                elif chunk:
                    incoming.extend(chunk)
                    while b'\n' in incoming:
                        line, _, rest = incoming.partition(b'\n')
                        incoming = bytearray(rest)
                        if len(line) > 16384:
                            return 65
                        event = json.loads(line.decode('utf-8'))
                        operation = event.get('op')
                        if operation == 'write':
                            data = base64.b64decode(event.get('data', ''), validate=True)
                            if len(data) > 8192 or len(pending) + len(data) > 262144:
                                return 65
                            pending.extend(data)
                        elif operation == 'resize':
                            next_rows, next_columns = int(event['rows']), int(event['columns'])
                            if not 1 <= next_rows <= 200 or not 1 <= next_columns <= 500:
                                return 65
                            resize(master, next_rows, next_columns)
                        elif operation == 'close':
                            pending.clear()
                            signal_group(pid, signal.SIGHUP)
                            close_deadline = time.monotonic() + 1.0
                        else:
                            return 65
                    if len(incoming) > 16384:
                        return 65
            if master in ready_read:
                try:
                    chunk = os.read(master, 65536)
                except BlockingIOError:
                    chunk = None
                except OSError:
                    chunk = b''
                if chunk == b'':
                    master_eof = True
                elif chunk:
                    view = memoryview(chunk)
                    while view:
                        written = os.write(1, view)
                        view = view[written:]
            if master in ready_write and pending:
                try:
                    written = os.write(master, pending[:4096])
                    del pending[:written]
                except BlockingIOError:
                    pass
                except OSError:
                    pending.clear()
        if child_status is None:
            try:
                _, child_status = os.waitpid(pid, 0)
            except ChildProcessError:
                child_status = 0
        if os.WIFEXITED(child_status):
            return os.WEXITSTATUS(child_status)
        if os.WIFSIGNALED(child_status):
            return 128 + os.WTERMSIG(child_status)
        return 1
    finally:
        signal_group(pid, signal.SIGKILL)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(master)
        if identity_path:
            try:
                os.unlink(identity_path)
            except OSError:
                pass


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        sys.stderr.write('PTY relay failed: %s\n' % error)
        sys.exit(70)
