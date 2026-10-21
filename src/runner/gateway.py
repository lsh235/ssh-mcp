"""Ephemeral same-channel RPC after a post-SSH login gate. No credentials here."""
import base64
import concurrent.futures
import json
import os
import signal
import subprocess
import sys
import threading

prefix = sys.argv[1]
output_lock = threading.Lock()
worker_lock = threading.Lock()
jobs_lock = threading.Lock()
jobs = set()
worker = None
stopping = False


def interrupted(_signum, _frame):
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, signal.SIG_IGN)
    raise SystemExit(0)


for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(signum, interrupted)


def emit(value):
    with output_lock:
        print(prefix + json.dumps(value, separators=(',', ':')), flush=True)


def kill_group(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def execute(req):
    maximum = req['maximum']
    p = subprocess.Popen(['bash', '--noprofile', '--norc', '-c', req['command']],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, start_new_session=True)
    with jobs_lock:
        if stopping:
            kill_group(p)
        jobs.add(p)
    output = [bytearray(), bytearray()]
    size = [0]
    exceeded = threading.Event()
    size_lock = threading.Lock()

    def drain(stream, index):
        while True:
            data = stream.read1(16384)
            if not data:
                break
            with size_lock:
                keep = max(0, maximum - size[0])
                output[index].extend(data[:keep])
                size[0] += len(data)
                if size[0] > maximum:
                    exceeded.set()
                    kill_group(p)
        stream.close()

    def feed():
        try:
            p.stdin.write(req['input'].encode('utf-8'))
            p.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    threads = [threading.Thread(target=drain, args=(p.stdout, 0)),
               threading.Thread(target=drain, args=(p.stderr, 1)),
               threading.Thread(target=feed)]
    for t in threads:
        t.start()
    timed_out = False
    try:
        p.wait(timeout=req['timeout'])
        # Descendants can keep the pipes open after their parent exits.
        for t in threads:
            t.join(timeout=req['timeout'])
        if any(t.is_alive() for t in threads):
            raise subprocess.TimeoutExpired('remote helper', req['timeout'])
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_group(p)
        p.wait()
    finally:
        for t in threads:
            t.join()
        with jobs_lock:
            jobs.discard(p)
    return {'code': p.returncode, 'stdout': base64.b64encode(output[0]).decode(),
            'stderr': base64.b64encode(output[1]).decode(),
            'limit': exceeded.is_set(), 'timeout': timed_out}


def monitor(p):
    p.wait()
    if not stopping:
        emit({'event': 'worker_lost'})


def handle(req):
    global worker
    try:
        op = req['op']
        if op == 'exec':
            result = execute(req)
        elif op == 'start':
            with worker_lock:
                if stopping or worker is not None:
                    raise ValueError('already started')
                worker = subprocess.Popen(
                    ['bash', '--noprofile', '--norc', '-c', req['worker'], '--',
                     req['dir'], req['root'], str(req['maximum']), str(os.getpid()),
                     open('/proc/self/stat').read().rsplit(')', 1)[1].split()[19]],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, start_new_session=True)
            # Do not hold worker_lock across blocking I/O: disconnect cleanup must
            # be able to kill an unready worker and unblock this read.
            if worker.stdout.readline(1024) != b'SHELL_MCP_READY\n':
                raise ValueError('worker unavailable')
            worker.stdout.close()
            threading.Thread(target=monitor, args=(worker,), daemon=True).start()
            result = {}
        elif op == 'submit':
            with worker_lock:
                if worker is None or worker.poll() is not None:
                    raise ValueError('worker unavailable')
                worker.stdin.write((req['commandId'] + '\n').encode())
                worker.stdin.flush()
            result = {}
        else:
            raise ValueError('unsupported operation')
        emit({'id': req['id'], **result})
    except Exception:
        # Never include commands, stdin, paths, or remote tracebacks in errors.
        emit({'id': req.get('id'), 'error': True})


print('\n' + prefix + 'READY', flush=True)
pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
try:
    for line in sys.stdin.buffer:
        if len(line) > 8388608:
            break
        pool.submit(handle, json.loads(line))
finally:
    with jobs_lock:
        stopping = True
        for job in jobs:
            kill_group(job)
    with worker_lock:
        if worker is not None:
            kill_group(worker)
    pool.shutdown(wait=True)
