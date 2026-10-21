umask 077
__sm_dir=$1
__sm_root=$2
__sm_limit=$3
__sm_python=$(command -v python3)
__sm_mkfifo=$(command -v mkfifo)
readonly __sm_dir __sm_root __sm_limit __sm_python __sm_mkfifo
cd -- "$__sm_root" || exit 71
exec 3<&0
exec </dev/null
"$__sm_python" -c 'import json,os,sys; p=int(sys.argv[1]); json.dump({"pid":p,"start":open("/proc/%s/stat"%p).read().rsplit(")",1)[1].split()[19]},open(sys.argv[2],"w"))' "$$" "$__sm_dir/identity"
if [[ -n ${4-} ]]; then
  # Gateway agent and worker are different sessions. Reap the managed group even
  # if the agent is killed before its Python finally block can run.
  "$__sm_python" -c 'import json,os,pathlib,signal,sys,time
parent,start,identity=sys.argv[1:4]; worker=json.load(open(identity))
def state(pid):
 try:
  parts=pathlib.Path("/proc",str(pid),"stat").read_text().rsplit(")",1)[1].split()
  return parts[0],parts[19]
 except (FileNotFoundError,ProcessLookupError): return None,None
while True:
 ws,wt=state(worker["pid"])
 if wt!=worker["start"] or ws=="Z": break
 ps,pt=state(parent)
 if pt!=start or ps=="Z":
  try: os.killpg(worker["pid"],signal.SIGKILL)
  except ProcessLookupError: pass
  break
 time.sleep(.1)
' "$4" "$5" "$__sm_dir/identity" >/dev/null 2>&1 &
fi
printf 'SHELL_MCP_READY\n'
while IFS= read -r __sm_id <&3; do
  [[ $__sm_id =~ ^c_[a-f0-9-]+$ ]] || exit 72
  "$__sm_mkfifo" "$__sm_dir/$__sm_id.outpipe" "$__sm_dir/$__sm_id.errpipe" || exit 74
  "$__sm_python" -c 'import sys; p=sys.argv[1]; limit=int(sys.argv[2]); written=0
with open(p,"wb",buffering=0) as f:
 while True:
  b=sys.stdin.buffer.read1(4096)
  if not b: break
  keep=b[:max(0,limit-written)]
  f.write(keep); written+=len(keep)
  if len(keep)<len(b): open(p+".truncated","w").close()
' "$__sm_dir/$__sm_id.stdout" "$__sm_limit" <"$__sm_dir/$__sm_id.outpipe" &
  __sm_outpid=$!
  "$__sm_python" -c 'import sys; p=sys.argv[1]; limit=int(sys.argv[2]); written=0
with open(p,"wb",buffering=0) as f:
 while True:
  b=sys.stdin.buffer.read1(4096)
  if not b: break
  keep=b[:max(0,limit-written)]
  f.write(keep); written+=len(keep)
  if len(keep)<len(b): open(p+".truncated","w").close()
' "$__sm_dir/$__sm_id.stderr" "$__sm_limit" <"$__sm_dir/$__sm_id.errpipe" &
  __sm_errpid=$!
  __sm_mode=$(<"$__sm_dir/$__sm_id.mode")
  if [[ $__sm_mode == pipe ]]; then
    "$__sm_mkfifo" "$__sm_dir/$__sm_id.inpipe" || exit 76
    "$__sm_python" -c 'import base64,json,pathlib,sys,time
directory,cid,parent=sys.argv[1:4]; seq=1
try:
 while True:
  if not pathlib.Path("/proc",parent).exists(): break
  path=pathlib.Path(directory)/(cid+".input.%08d"%seq)
  if not path.exists(): time.sleep(0.025); continue
  entry=json.loads(path.read_text())
  sys.stdout.buffer.write(base64.b64decode(entry["content"])); sys.stdout.buffer.flush()
  if entry["end"]: break
  seq+=1
except BrokenPipeError: pass
' "$__sm_dir" "$__sm_id" "$$" >"$__sm_dir/$__sm_id.inpipe" &
    __sm_inpid=$!
    # Redirection changes stdin only; source still runs in this persistent Bash.
    source "$__sm_dir/$__sm_id.sh" <"$__sm_dir/$__sm_id.inpipe" >"$__sm_dir/$__sm_id.outpipe" 2>"$__sm_dir/$__sm_id.errpipe"
    __sm_code=$?
    kill "$__sm_inpid" 2>/dev/null
    wait "$__sm_inpid" 2>/dev/null
  else
    source "$__sm_dir/$__sm_id.sh" >"$__sm_dir/$__sm_id.outpipe" 2>"$__sm_dir/$__sm_id.errpipe"
    __sm_code=$?
  fi
  wait "$__sm_outpid" "$__sm_errpid" || exit 75
  "$__sm_python" -c 'import json,os,sys; p=sys.argv[1]; f=p+".tmp"; json.dump({"exitCode":int(sys.argv[2]),"cwd":sys.argv[3]},open(f,"w")); os.replace(f,p)' "$__sm_dir/$__sm_id.done" "$__sm_code" "$PWD" || exit 73
done
