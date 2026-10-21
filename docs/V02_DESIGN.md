# v0.2 추가 기능 설계

범위: stdin 입력, 명령 대기, 원격 검색, 명령 이력, 명시적인 새 세션 열기. v0.1의 기존 도구와 비대화형 실행 기본값을 유지합니다. 기존 원본·컨테이너 프로젝트와 v0.1 시험 기록을 보존합니다. 구현 시작 시점의 소스 해시는 `test-results/v02/baseline-v01.json`에 기록했습니다.

## 도구와 동작

| 도구 | 입력 | 동작 |
| --- | --- | --- |
| `run_command` 확장 | `inputMode: closed\|pipe` | 기본 closed는 기존처럼 stdin=/dev/null. pipe는 입력을 기다리는 일반 프로그램 지원 |
| `send_input` | commandId, data, end, clientRequestId | UTF-8 입력을 순서대로 전달. end=true면 해당 데이터 뒤 EOF. 기본 개행을 자동 추가하지 않음 |
| `wait_command` | commandId, waitMs | 최대 10초 대기 후 상태 반환. 완료 전에는 반환 여부를 명시. 대기 취소가 작업 취소를 뜻하지 않음 |
| `search_files` | sessionId, query, path, caseSensitive, cursor, maxResults | 등록 workspace의 UTF-8 파일을 리터럴 검색. 파일·바이트·결과 상한과 제외 경로 적용 |
| `list_commands` | sessionId, state, cursor, maxResults | 소유자의 세션 명령을 접수 순서로 조회. 명령 본문과 stdin 내용은 저장/반환하지 않음 |
| `reopen_session` | sessionId, clientRequestId | closed/broken 세션과 같은 대상·workspace에 새 ID/세대를 생성. 원래 명령은 재실행하지 않음 |

## 입력 전달

SSH 명령 제어용 FD 3과 사용자 stdin을 분리합니다. pipe 명령에는 전용 FIFO와 Python feeder를 붙이며, feeder는 명령별 번호가 있는 입력 파일을 읽습니다. 출력 수집과 셸 상태 유지는 기존 방식으로 유지합니다. 전경 명령이 끝나면 feeder를 정리합니다.

서버는 입력 요청 ID·내용 해시·순서·예약 바이트 수를 먼저 SQLite에 기록하고, C에 입력 파일을 임시 쓰기/rename으로 게시합니다. 같은 요청 ID/내용은 기존 결과를 반환합니다. 다른 내용에는 REQUEST_CONFLICT를 반환합니다. ACK 유실로 전달 여부가 불명확하면 unknown을 반환하고 이후 입력을 막습니다. 알려지지 않은 입력을 자동 재전달하지 않습니다. B 재시작 후 접수 중 입력은 unknown으로 복구합니다.

기본 제한은 메시지당 16 KiB, 명령당 1 MiB/128개 메시지입니다. 입력 내용은 감사 로그나 SQLite 레코드에 저장하지 않습니다. 원격 임시 입력 파일은 명령 종료 정리 대상입니다. 일반 프로그램이 입력을 출력하면 그 내용은 stdout/stderr 로그에 포함될 수 있습니다.

PTY는 제공하지 않습니다. `input()`·`read`·일반 stdin 스트림은 지원하되, 터미널 에뮬레이션·화면 앱·sudo 비밀번호 대화·Ctrl+C 전달은 이 버전에 포함하지 않습니다. 취소는 기존처럼 worker 프로세스 그룹 전체를 끝냅니다.

## 검색·조회 경계

검색은 기본적으로 .git, .venv, node_modules, __pycache__를 제외합니다. 심볼릭 링크를 따르지 않고 UTF-8 일반 파일만 읽습니다. 최대 1,000개 파일/1,000개 디렉터리/10,000개 경로 항목/10 MiB/파일 1 MiB를 검사하고 페이지당 100개 결과를 반환합니다. 상한 또는 파일 읽기 실패가 있으면 불완전 여부와 누락 이유를 표시합니다. 검색은 스냅샷이 아니며 파일 변경 시 페이지 결과가 달라질 수 있습니다.

명령 이력은 SQLite의 접수 순서를 바탕으로 페이지를 나눕니다. 공개 커서에 순서를 사용하고 상태 필터가 변하면 페이지 내용도 달라질 수 있음을 명시합니다. 모든 조회와 입력에서 소유자·대상 권한을 다시 검사합니다.

## 세션 다시 열기

`reopen_session`은 손실된 셸 복원이 아닙니다. 이전 sessionId와 previousSessionId 관계를 기록하고 generation을 증가시킨 **새 셸**입니다. cwd·export·venv·초기화 명령을 자동 복구하지 않습니다. 실행 중인 세션을 재개 대상으로 받지 않습니다. 연결 유실 후 불확실한 명령은 과거 세션에 남겨 조회할 수 있습니다.

## 검증 및 종료 기준

1. 실제 SSH: 입력 대기 → 두 차례 입력 → EOF → 종료 코드와 출력 확인. 다음 명령에서도 셸 환경 유지.
2. 입력 중복·EOF 이후 입력·일반 모드 입력·타 소유자·메시지/누적 제한을 검증.
3. 검색: 정상·페이지·제외 경로·symlink·바이너리·상한 결과 확인. 이력: 소유자·세션·필터·커서 확인.
4. 세션 취소/연결 손실 이후 새 ID와 증가한 세대 확인, 과거 명령 재실행 없음.
5. 기존 v0.1 회귀 + 빌드/기동 + 기존 Docker 대상에서 현재 Codex가 실제 MCP 호출.

설계/구현/검증의 한 사이클로 끝내고, 외부 Copilot·OAuth·공개 배포·PTY·영속 셸 복구는 자동으로 추가하지 않습니다. 미통과 항목은 PASS로 바꾸지 않고 기록합니다.
