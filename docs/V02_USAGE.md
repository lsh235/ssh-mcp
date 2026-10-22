# v0.2 추가 도구 사용법

v0.2는 기존 도구 14개를 유지하고 5개를 추가해 총 19개를 제공합니다. [설계](V02_DESIGN.md)와 [검증 결과](V02_STATUS.md)를 함께 확인하세요.

## 프로그램 입력과 EOF

`run_command`의 기본값 `inputMode=closed`는 기존처럼 stdin을 닫습니다. 입력이 필요한 일반 프로그램은 `pipe`를 선택합니다.

```json
{
  "sessionId": "현재 세션 ID",
  "command": "python3 -u -c \"name=input('name> '); print('hello='+name)\"",
  "inputMode": "pipe",
  "clientRequestId": "ask-name-1",
  "waitMs": 300
}
```

반환된 명령이 `running`이 되면 `send_input`을 호출합니다. `accepted`라면 `get_command`로 준비 상태를 확인합니다. `INPUT_NOT_READY`는 입력을 아직 접수하지 않았다는 뜻입니다.

```json
{
  "commandId": "반환된 명령 ID",
  "data": "코덱스\n",
  "end": true,
  "clientRequestId": "name-answer-1"
}
```

개행은 자동 추가하지 않습니다. 여러 차례 입력하려면 마지막 데이터에만 end=true를 지정합니다. 데이터 없이 end=true를 보내면 EOF만 전달합니다. 한 번 닫은 stdin은 다시 열 수 없습니다.

`published`는 입력이 원격 큐에 게시됐다는 뜻이며 프로그램이 소비했다는 보장은 아닙니다. HTTP 응답이 유실되면 **같은 요청 ID와 같은 내용**으로 조회합니다. 다른 내용에 같은 ID를 쓰면 REQUEST_CONFLICT입니다. 입력이 unknown이면 재전달하지 않으며, 후속 입력도 INPUT_UNCERTAIN으로 막습니다.

기본 제한은 입력 1건 16 KiB, 명령당 1 MiB와 128건입니다. UTF-8 바이트 수로 계산하며 EOF 메시지도 건수에 포함됩니다. 서버 설정의 limits.maxInputBytes / maxInputMessages로 누적 제한을 바꿀 수 있습니다.

서버 감사 로그와 SQLite에는 입력 본문을 넣지 않습니다. 원격의 임시 입력 파일에는 내용이 들어가며 명령 종료 시 정리됩니다. MCP 클라이언트의 별도 호출 기록에는 입력 인자가 남을 수 있고, 프로그램이 입력을 출력하면 stdout/stderr에도 포함됩니다.

## PTY 대화형 프로그램 (v0.12.0)

일반 `run_command`는 계속 non-PTY로 실행합니다. `vim`, `top`, REPL처럼 실제 TTY가 필요한 프로그램에는 별도 `open_terminal`을 사용합니다. 이 도구는 기존 sessionId의 관리 Bash 안에서 원격 PTY 자식 프로세스를 띄우므로 `cd`와 export 환경을 물려받고, PTY 종료 뒤에는 같은 관리 셸을 계속 사용할 수 있습니다.

초기 크기는 24행×80열입니다. `read_terminal`은 병합된 출력에 ANSI 바이트를 보존하고, `write_terminal`은 입력 문자열을 그대로 보냅니다. Enter는 `\n`, Ctrl+C는 해당 앱이 처리하는 경우 U+0003 (`\u0003`)을 입력합니다. `resize_terminal`은 원격 창 크기를 바꾸고 foreground 프로세스에 SIGWINCH를 전달합니다. 요청 ID를 재사용해 응답 유실을 확인하며, 입력이 unknown이면 새 ID로 재전송하지 않습니다.

```json
{"tool":"open_terminal","arguments":{"sessionId":"SESSION_ID","command":"vim src/app.ts","clientRequestId":"terminal-open-001","rows":24,"columns":80}}
{"tool":"read_terminal","arguments":{"commandId":"COMMAND_ID","cursor":0}}
{"tool":"write_terminal","arguments":{"commandId":"COMMAND_ID","data":"i","clientRequestId":"terminal-input-001"}}
{"tool":"resize_terminal","arguments":{"commandId":"COMMAND_ID","rows":40,"columns":120,"clientRequestId":"terminal-resize-001"}}
{"tool":"close_terminal","arguments":{"commandId":"COMMAND_ID","clientRequestId":"terminal-close-001"}}
```

`close_terminal`은 PTY 프로세스 그룹에 hangup을 보내고 입력을 닫습니다. `cancel_command`나 deadline은 관리 셸과 등록된 PTY 프로세스 그룹을 끝내므로 셸 상태가 손실됩니다. 브라우저 세션 보기는 상태와 ANSI 원문 출력을 보여주지만 키 입력이 가능한 터미널 에뮬레이터는 아닙니다. 이 구현은 C에서 Python으로 controlling PTY를 만들며 SSH worker 채널 자체에는 protocol-level `pty-req`를 요청하지 않습니다. sudo 비밀번호 프롬프트와 GUI/X11은 지원 범위가 아닙니다.

## 완료 대기

```json
{"commandId":"명령 ID","waitMs":5000}
```

`wait_command`는 최대 10초까지 기다린 뒤 `command`, `terminal`, `waitedMs`를 반환합니다. terminal=false면 아직 실행 중입니다. terminal=true여도 성공 여부는 command.state와 exitCode로 판단합니다. unknown은 성공이 아닙니다. 대기 요청의 중단이 원격 작업의 취소를 뜻하지 않습니다.

## 원격 내용 검색

```json
{"sessionId":"세션 ID","query":"invoice_total","path":".","caseSensitive":true,"maxResults":50}
```

`search_files`는 정규식이 아닌 한 줄 리터럴을 검색합니다. 일치한 줄마다 첫 위치의 경로·행·열·짧은 내용을 돌려줍니다. 디렉터리 검색은 .git, .venv, node_modules, __pycache__를 기본 제외하고 symlink를 따라가지 않습니다. 등록 workspace 밖은 검색할 수 없습니다.

최대 파일 1,000개, 디렉터리 1,000개, 경로 항목 10,000개, 전체 10 MiB, 파일당 1 MiB를 검사합니다. 범위가 잘리거나 읽기 실패가 있으면 incomplete=true와 limitations를 확인하세요. 바이너리는 검색 대상에서 제외합니다. nextCursor가 있으면 같은 검색 조건과 해당 cursor로 다음 페이지를 요청합니다. 파일 변경과 검색 페이지 사이의 스냅샷 일관성은 제공하지 않습니다.

## 명령 이력

```json
{"sessionId":"세션 ID","state":"completed","maxResults":20,"cursor":0}
```

`list_commands`는 자신이 소유한 세션의 명령을 접수 순서로 조회합니다. state를 생략하면 전체 상태를 조회합니다. 커서는 숫자가 연속한다는 보장이 없으며, nextCursor 또는 lastCursor의 반환값을 그대로 사용합니다. 명령이 진행하면서 상태 필터의 결과는 달라질 수 있습니다. 명령 본문과 stdin 내용은 이력에 포함하지 않습니다.

## 새 세션 열기

```json
{"sessionId":"종료되거나 끊어진 세션 ID","clientRequestId":"reopen-1"}
```

`reopen_session`은 closed/broken 상태에서 같은 대상·workspace에 새 ID와 증가한 generation을 생성합니다. previousSessionId로 과거 세션과 연결됩니다. 기존 cwd·export·가상환경을 자동 복원하지 않고 이전 명령도 재실행하지 않습니다. 새 세션에서 환경을 명시적으로 준비하세요. 같은 요청 ID의 재호출은 같은 새 세션을 반환합니다.

## 기존 Docker 대상에 적용

```bash
npm run build
node scripts/docker-demo.mjs reload
SHELL_MCP_TRANSCRIPT_DIR=test-results/v02/docker node scripts/mcp-call.mjs <<'JSON'
{"method":"tools/list"}
JSON
```

reload는 이 workspace 소유의 MCP 프로세스를 정상 종료한 후 새 빌드를 기동합니다. 기존 컨테이너와 프로젝트 파일을 보존합니다. 실행 중인 명령은 서버 종료 규칙을 따르므로 변경 적용 전에 상태를 확인하세요. v0.1 원본 시험 기록에 새 호출을 섞지 않도록 별도 transcript 경로를 지정했습니다.
