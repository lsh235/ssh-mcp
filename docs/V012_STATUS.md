# v0.12.0 원격 PTY 대화형 명령

작성일: 2026-10-22, Asia/Seoul.

v0.12.0은 기존 non-PTY Bash 명령과 별도의 원격 POSIX PTY 실행 경로를 추가합니다. 기존 셸의 cwd/export 상태를 물려받아 TUI·REPL을 실행하고, PTY가 끝나면 managed Bash를 계속 사용할 수 있습니다. 고정된 OpenSSH fixture와 postLogin gate fixture에서 구현을 검증합니다. 사용자 PC의 VS Code/Copilot 수용, 외부 SSH 서버, 공개 HTTPS는 별도 항목입니다.

## 추가한 MCP 도구

| 도구 | 동작 |
| --- | --- |
| `open_terminal` | 현재 sessionId의 persistent Bash 안에서 원격 controlling PTY를 시작합니다. 기본 24행×80열, `TERM=xterm-256color`; 반환 commandId가 terminalId입니다. |
| `read_terminal` | 병합된 PTY 출력의 byte cursor·base64·UTF-8 미리보기와 실행 상태를 읽습니다. ANSI 바이트는 보존합니다. |
| `write_terminal` | UTF-8 입력을 원격 PTY에 보냅니다. Enter는 개행, Ctrl+C는 앱이 처리하는 경우 U+0003입니다. |
| `resize_terminal` | 1–200행, 1–500열로 크기를 바꾸고 커널의 foreground process-group SIGWINCH 동작을 사용합니다. |
| `close_terminal` | PTY 입력을 끝내고 child process group에 hangup을 보냅니다. 정상 종료라면 managed Bash는 유지됩니다. |

도구 입력은 기존 ownership 검사·요청 ID dedupe·input byte/message 한도를 거칩니다. 서버 SQLite와 감사 로그에는 터미널 입력 본문을 보관하지 않습니다. 브라우저 session view는 PTY 종류·크기·출력을 표시하지만, ANSI 제어 시퀀스를 꾸미거나 키 입력을 보내는 terminal emulator는 아닙니다.

## 구현·운영 경계

C의 `pty.py`가 controlling PTY를 열고 세션 리더에서 명령을 실행합니다. wrapper는 기존 managed Bash의 cwd/environment를 상속하며, MCP input journal과 출력 spool/redactor를 재사용합니다. postLogin 사용 시 이미 인증한 같은 SSH gateway channel 안에서 실행하며 게이트를 다시 열지 않습니다. PTY stderr는 stdout과 합쳐집니다.

SSH worker channel 자체는 계속 non-PTY이고 SSH protocol `pty-req`/`window-change`를 보내지 않습니다. 원격 POSIX 자식에는 실제 controlling PTY·TERM·행/열·SIGWINCH가 제공되지만 SSH channel 소유 방식은 Tabby와 동일하지 않습니다. `sudo` 비밀번호 도구, X11/GUI, Windows target은 지원하지 않습니다. deadline/cancel은 managed worker와 정확한 PID/start-time/process-group 기록이 있는 PTY child를 종료합니다. PTY 밖으로 새 session을 만들어 이탈한 프로세스는 감독하지 않습니다.

postLogin 출력 마스킹은 PTY의 병합 출력에도 적용됩니다. 마스커는 stream 끝의 설정값 prefix가 아닌 평범한 출력 바이트를 기다리지 않도록 개선했습니다. 비밀의 일부 접두부는 다음 chunk가 오거나 command가 끝날 때까지 보이지 않을 수 있으며, exact-byte 일치가 아닌 변형·재인코딩 출력은 기존 범위 밖입니다.

## 검증

- `npm run check`: PASS. build, 단위 시험 19개, 실제 OpenSSH 7개, HTTP 기능 시험 8개, postLogin 시험 10개, 브라우저 API 시험 6개(총 50개). PTY 시험은 초기 크기/TTY, resize/SIGWINCH, 입력, Ctrl+C, 정상 close 후 managed Bash 연속성, 강제 cancel과 고아 PTY 프로세스 회수, postLogin 같은 channel과 출력 마스킹을 확인합니다.
- `npm run smoke`: PASS. 컴파일된 HTTP 서버 health, 인증된 MCP 발견·호출, 도구 25개.
- `npm run test:soak`: PASS. 121초 SSH 명령의 live output과 완료 뒤 셸 상태 유지, 실제 시험시간 122.985초.
- `node dist/cli.js --version`: `0.12.0`; package.json/package-lock.json도 일치.
- `git diff --check`: PASS.

로컬 격리 sshd와 HTTP MCP 시험입니다. 실제 VS Code Integrated Browser/Copilot에서의 도구 노출·입력, 외부 SSH 장비, 공개 HTTPS/IdP는 NOT RUN입니다.
