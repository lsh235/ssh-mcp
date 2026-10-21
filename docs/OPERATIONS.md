# 설치·연결·운영

Shell MCP 0.3.0은 원격 MCP 설치 PC(B)에서 실행합니다. B의 SSH 인증정보로 작업 대상 PC(C)에 접속합니다. Tabby 앱이나 기존 Tabby MCP 플러그인을 실행할 필요는 없습니다. 입력·검색·이력·세션 도구는 [v0.2 사용법](V02_USAGE.md), SSH 접속 후 추가 로그인은 [LOGIN_SETUP](LOGIN_SETUP.md)을 참고하세요.

## 준비

- B: Linux, Node.js 22.16 이상, npm, OpenSSH 클라이언트. 검증 환경은 Node.js 22.23.2입니다.
- C: Linux, OpenSSH 서버, Bash, **Python 3.9 이상**, util-linux `setsid --wait`, `mkfifo`, 필요 빌드 도구.
- B의 서비스 계정에서 `ssh dev-linux` 접속이 이미 준비되어 있어야 합니다. known_hosts에 신뢰할 host key를 사전 등록하고, agent 또는 키를 준비합니다.
- SSH 자체 비밀번호·MFA 인증과 일반 PTY 명령은 지원하지 않습니다. SSH 접속 후 추가 로그인에는 postLogin 설정을 사용할 수 있습니다(최종 셸에 stty 필요). 기본 stdin은 `/dev/null`이며 일반 stdin 프로그램에는 inputMode=pipe / send_input을 사용합니다.
- 상주 서비스는 B에만 설치합니다. C의 `/tmp/shell-mcp-*`에 세션 전용 도우미·FIFO·로그가 생기고, 정상 완료한 명령 파일과 닫힌 세션 파일은 정리됩니다.

## 빌드

```bash
npm ci
npm run build
node dist/cli.js --help
npm run smoke
```

`better-sqlite3`는 네이티브 의존성이므로 사전 빌드가 없는 플랫폼에서는 C/C++ 빌드 도구가 필요할 수 있습니다. 첫 버전은 검증한 Linux 환경을 기준으로 합니다.

## 개인 개발용 기동

`config.token.example.json`을 `config.local.json`에 복사한 뒤 대상 별칭과 원격 workspace 경로를 바꿉니다. 비밀은 JSON에 저장하지 않습니다.

```bash
read -rsp 'Shell MCP token: ' SHELL_MCP_TOKEN; echo
export SHELL_MCP_TOKEN
node dist/cli.js --config config.local.json
```

토큰은 최소 32바이트를 사용합니다. 이 모드는 테스트 또는 신뢰된 개인 환경에서 수동 인증 헤더를 설정하는 클라이언트용입니다. 외부에서 접속할 때는 HTTPS 프록시 뒤에 두고 publicUrl·allowedHosts를 실제 주소에 맞춥니다. 서비스는 loopback에만 바인딩합니다.

## 원격 Copilot용 OAuth 구성

`config.example.json`의 예시 주소·계정·workspace를 실제 값으로 바꿉니다. IdP가 발급하는 JWT access token의 issuer, audience, JWKS 주소, 주체, `shell:use` scope를 설정합니다. 공개 URL은 HTTPS여야 합니다.

서버는 다음 메타데이터를 제공합니다.

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource`

인증 없이 `/mcp`에 접근하면 메타데이터 주소를 포함한 `WWW-Authenticate` 응답을 반환합니다. access token은 서명·만료·발급자·대상·허용 주체·scope를 검사합니다. 서버 자체가 OAuth 로그인 화면이나 토큰 발급을 구현하지는 않습니다. **사용할 IdP와 Copilot 사이의 클라이언트 등록/리디렉션 정책을 준비해야 하며, 실제 IdP·Copilot 로그인은 아직 검증하지 않았습니다.**

`deploy/Caddyfile.example`은 B의 공개 HTTPS 주소를 내부 `127.0.0.1:8787`에 연결하는 예시입니다. DNS·인증서·방화벽·프록시 설치는 이 작업에서 수행하지 않았습니다. IdP 주체와 `targets.*.principals` 값이 일치해야 작업 대상이 보입니다.

## 사용자 서비스

`deploy/shell-mcp.service`는 사용자 단위 systemd 예시입니다. 설치 경로와 Node 경로를 자신의 환경에 맞게 수정합니다. root 시스템 서비스에 그대로 설치하지 않습니다.

```bash
mkdir -p ~/.config/shell-mcp ~/.config/systemd/user
cp config.example.json ~/.config/shell-mcp/config.json
cp deploy/shell-mcp.service ~/.config/systemd/user/shell-mcp.service
# config.json의 대상, 인증과 주소를 수정한 뒤 실행
systemctl --user daemon-reload
systemctl --user enable --now shell-mcp
```

agent를 쓰면 사용자 서비스 환경에 실제 `SSH_AUTH_SOCK`을 제공해야 합니다. 새 로그인에서 agent 소켓이 바뀌면 서비스 환경도 갱신합니다. agent 정보나 키를 채팅에 붙여 넣지 않습니다.

```bash
systemctl --user import-environment SSH_AUTH_SOCK
systemctl --user restart shell-mcp
```

## VS Code

- Copilot portable 형식: `examples/copilot.mcp.json`을 참조해 실제 HTTPS MCP 주소를 등록합니다. OAuth 인증과 클라이언트 등록이 준비되어야 합니다.
- Local harness의 VS Code 형식: `examples/vscode-local.mcp.json`은 개발용 토큰 예시입니다. URL을 맞추고 토큰을 비밀번호 입력 창으로 제공합니다.
- 두 형식은 최상위 키가 다릅니다. `${input:...}`가 있는 서버는 현재 문서상 Copilot harness에 전달되지 않으므로 Local 예시를 Copilot 공통 설정으로 복사하지 않습니다.

첫 요청 예시:

> shell-mcp 도구로 허용된 대상을 확인하고 dev-linux의 sample workspace에 세션을 열어줘. 원격 파일을 읽고 테스트 실패 원인을 수정한 뒤, 같은 세션에서 테스트하고 diff를 보여줘. 로컬 파일을 대신 수정하지 말고, unknown 상태의 명령은 자동 재실행하지 마.

`open_session`의 sessionId와 `run_command`의 commandId를 후속 조회에 사용합니다. `read_output`은 바이트 커서를 사용하며 `base64`는 정확한 원본 바이트, `content`는 사람이 읽기 위한 UTF-8 미리보기입니다. 페이지 경계에서 다중 바이트 문자가 나뉠 때 정확한 재구성에는 base64를 사용합니다.

## 상태·취소·보관

- `completed`는 명령이 종료됐다는 뜻입니다. 성공 여부는 exitCode로 판단합니다.
- `unknown`은 실행 또는 결과가 불확실합니다. 새 요청 키로 자동 재실행하지 않습니다.
- 강제 취소와 시간 초과는 managed 셸의 프로세스 그룹을 종료합니다. 셸 상태는 손실되며 새 세션이 필요합니다. 그룹을 이탈한 프로세스까지 회수하는 감독 기능은 없습니다.
- 종료 코드·cwd가 확정된 완료 기록을 얻기 전에는 성공으로 채우지 않습니다.
- 재시작 시 실행 중이던 명령은 unknown, 활성 세션은 broken으로 복구합니다. 이전 Bash 프로세스의 상태 복원은 제공하지 않습니다.
- 명령 출력은 스트림별 기본 1 MiB, 최대 설정 10 MiB로 제한합니다. 넘친 내용은 버리되 파이프는 계속 읽어 실행을 막지 않습니다. 일반 빌드 파일의 크기는 제한하지 않습니다.
- 출력 파일은 기본 24시간 후 다음 정리 주기에 삭제합니다. 명령 메타데이터와 요청 키는 재실행 방지를 위해 남깁니다. 명령 이력 10,000개 한도에 도달하면 새 실행을 거부합니다. 필요하면 서비스를 중지하고 state 디렉터리를 백업·교체해 새 보관 주기를 시작합니다. 교체 후에는 예전 요청 키의 중복 방지 기록이 사라집니다.
- SQLite와 출력은 stateDir, 감사 기록은 `audit.jsonl`에 저장됩니다. 감사 로그의 외부 회전과 디스크 용량 관리는 운영자가 설정해야 합니다. 키·토큰·명령 본문은 감사 로그에 기록하지 않지만 원격 프로그램 출력에는 비밀이 포함될 수 있습니다.
- 비정상 SSH 단절 뒤 C에 남는 임시 디렉터리는 자동으로 광역 삭제하지 않습니다. 활성 작업이 없는지 확인한 뒤 해당 세션 디렉터리만 정리합니다.

## 파일과 권한의 한계

파일 도구는 workspace 상대 경로만 받고 심볼릭 링크를 거부합니다. 패치에는 읽을 때 받은 해시를 제공하며, 새 파일의 버전은 null입니다. 첫 버전은 1 MiB 이하 UTF-8 일반 파일, 기존 부모 디렉터리, unified diff를 지원합니다. rename·바이너리·권한 변경은 지원하지 않습니다.

여러 파일 패치는 전체 사전 검사 후 파일별 임시 쓰기/rename을 수행합니다. 파일 시스템 전체 트랜잭션이나 외부 편집자와의 완전한 CAS는 제공하지 않습니다. 오류 시 `partial_apply`를 확인하고 다시 읽습니다. 신뢰된 전용 worktree에서 사용합니다.

셸 명령은 C의 SSH 사용자 권한으로 실행됩니다. 파일 도구의 경로 제한이 임의 셸 명령을 격리하지는 않습니다. 여러 인증 주체를 같은 OS 계정에 연결하는 것은 운영체제 수준 격리가 아닙니다. 첫 버전은 개인 소유자 환경을 기준으로 합니다.

## 검증 명령

```bash
npm run check       # 빌드, 서명·저장 테스트, 실제 격리 sshd + HTTP MCP 통합 시험
npm run test:soak   # 실제 SSH 121초 명령과 진행 출력·후속 셸 상태
npm run smoke      # dist로 빌드된 서버 기동·인증된 MCP 도구 호출
```

SSH 시험은 loopback의 임시 고포트 sshd와 임시 키만 사용합니다. 기존 SSH 설정·known_hosts·사용자 키를 수정하지 않습니다. `/usr/sbin/sshd` 실행이 가능한 Linux 환경이 필요합니다. 가상 환경 활성화 검증은 Python venv를 `--without-pip`으로 생성합니다.
