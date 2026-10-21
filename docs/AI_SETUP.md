# AI가 읽고 바로 설치·연결·사용하기

이 문서는 AI 에이전트의 실행 안내서입니다. 먼저 현재 환경을 확인하고, 사용자가 요청한 설치·설정·원격 개발을 진행합니다. 실행 권한이나 필요한 값이 없으면 완료한 단계와 남은 항목을 구분해 보고합니다. **문서를 읽는 것만으로 MCP 도구가 현재 대화에 등록되지는 않습니다.** 클라이언트 설정과 실제 도구 호출까지 확인해야 합니다.

## 1. 역할과 필요한 값 확인

```text
A: 사용자 PC / VS Code·Copilot 등 AI 클라이언트
          │ HTTPS /mcp
B: 이 저장소를 설치할 Linux PC / 자체 SSH 설정·키·agent
          │ OpenSSH + 지속 Bash
C: 실제 프로젝트 PC / 기존 SSH 서버와 프로젝트
```

이미 MCP가 연결되어 있다면 5절부터 진행합니다. 서버 설치가 필요하면 B에서 2~3절을, 클라이언트 연결은 A에서 4절을 진행합니다. A에 B의 서버를 중복 기동하지 않습니다. B와 C가 같더라도 현재 구현은 SSH로 접속하므로 SSH 대상 설정이 필요합니다.

SSH 인증 성공 뒤 추가 로그인 화면이 있다면 [LOGIN_SETUP](LOGIN_SETUP.md)의 대상별 postLogin 설정을 먼저 준비합니다. 값은 B의 비공개 파일·환경변수에 두고, 실제 안내 문구와 최종 셸 프롬프트를 설정합니다. 아래의 `ssh ... command` 사전 점검은 게이트에 막힐 수 있으므로 해당 대상은 postLogin 설정 후 실제 open_session과 읽기 도구로 확인합니다.

현재 대화의 SSH 작업을 브라우저에서 보고 싶다면 [VSCODE_BROWSER](VSCODE_BROWSER.md)를 따릅니다. create_session_view에 이 대화의 SSH 세션 ID만 전달하고 반환된 URL을 VS Code Integrated Browser 또는 일반 브라우저에서 엽니다. 실제 토큰은 사용자가 화면에 직접 입력합니다.

| 확인할 값 | 확인 방법 / 예시 |
| --- | --- |
| 현재 실행 위치 | 현재 PC가 A/B/C 중 어디인지, 사용 가능한 원격 실행 경로 확인 |
| B 설치 경로·서비스 계정 | 기존 clone, 프로세스, 서비스 확인. 예: `/home/mcp/ssh-mcp` |
| 공개 MCP 주소 | 운영자가 제공한 실제 HTTPS 주소. 예: `https://mcp.example.com/mcp` |
| B에서 C로 가는 SSH 별칭 | B 서비스 계정의 SSH config. 예: `dev-linux` |
| C 프로젝트 절대 경로 | 기존 프로젝트 위치. 예: `/srv/projects/sample` |
| targetId / workspaceId | 서버 설정 또는 `list_targets` 결과. 예: `dev-linux` / `sample` |
| 인증 방식 | 개인 개발용 토큰 또는 운영자가 준비한 OAuth IdP |
| A의 클라이언트 | VS Code Local harness / Copilot harness / 다른 MCP 클라이언트 |

예시 주소·경로를 실환경 값으로 바꿉니다. JSON 경로에 `~`나 `$HOME`을 쓰지 않습니다. 접근 가능한 기존 설정에서 먼저 확인하고, 알 수 없는 필수 값만 사용자에게 묻습니다. 토큰·키의 원문을 채팅으로 요청하지 않습니다.

## 2. B 설치와 C 접속 확인

B: Linux, Node.js >=22.16, npm, Git, OpenSSH 클라이언트. C: Linux, OpenSSH 서버, Bash, Python >=3.9, util-linux의 `setsid --wait`, `mkfifo`, 프로젝트 빌드 도구가 필요합니다. 네이티브 SQLite 모듈의 사전 빌드가 없으면 B에 C/C++ 빌드 도구도 필요합니다.

B의 서비스 계정으로 실행합니다. 이미 clone이 있으면 재사용하고 변경 내용을 보존합니다.

```bash
git clone https://github.com/lsh235/ssh-mcp.git
cd ssh-mcp
npm ci
npm run build
npm run smoke
```

현재 B 사용자에게 이미 준비된 SSH 별칭을 사용합니다. 예를 들어 B의 `~/.ssh/config`에는 다음 항목이 있을 수 있습니다. 기존 파일에 해당 별칭만 병합합니다.

```sshconfig
Host dev-linux
    HostName target.example.com
    User developer
    Port 22
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking yes
```

키 대신 기존 agent를 사용할 수도 있습니다. agent의 `SSH_AUTH_SOCK`은 B의 서버 프로세스에서도 접근 가능해야 합니다. C의 host key는 신뢰된 경로로 지문을 확인하여 known_hosts에 등록합니다. `StrictHostKeyChecking=no`로 우회하거나 확인하지 않은 `ssh-keyscan` 결과를 그대로 신뢰하지 않습니다.

다음은 B에서 C로 실행하는 비변경 점검입니다. 별칭·프로젝트 경로를 실제 값으로 변경합니다. 별도 `sshConfig`를 쓴다면 이 점검에도 `ssh -F /절대경로/config`를 사용합니다.

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes dev-linux \
  'command -v bash && python3 -c "import sys; assert sys.version_info >= (3, 9)" && command -v mkfifo && setsid --wait true && test -d /srv/projects/sample && test -w /srv/projects/sample'
```

출력과 종료 코드를 모두 확인합니다. SSH 자체의 비밀번호·MFA 대화 인증은 현재 지원하지 않습니다. SSH 실패를 MCP 설정 변경으로 우회하지 않습니다. SSH 인증 이후 추가 로그인은 postLogin의 별도 흐름을 사용합니다.

## 3. B 서버 설정과 기동

개인 소유자 환경의 토큰 방식부터 설명합니다. 다음 파일은 **템플릿**입니다.

```bash
cp examples/config.remote-token.example.json config.local.json
```

`config.local.json`에서 publicUrl, allowedHosts, stateDir, sshConfig, workspace 경로를 실제 값으로 바꿉니다. stateDir은 서비스 계정만 접근 가능한 절대 경로로 정하고 하나의 서버 프로세스만 사용합니다. `auth.principal`과 해당 target의 `principals`가 일치해야 합니다. 토큰은 JSON에 넣지 않습니다.

토큰은 비밀 관리 도구에서 제공하거나, B에서 아래처럼 파일로 한 번 생성할 수 있습니다. 파일이 존재하면 덮어쓰지 않습니다. 생성한 토큰을 출력하지 않습니다.

```bash
install -d -m 700 "$HOME/.config/shell-mcp"
python3 - <<'PY'
from pathlib import Path
import os, secrets
p = Path.home() / '.config/shell-mcp/service.env'
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('SHELL_MCP_TOKEN=' + secrets.token_hex(32) + '\n')
PY
```

터미널에서 직접 실행하려면 B의 Bash를 사용합니다. 아래 환경 파일은 위에서 직접 생성한 신뢰된 파일을 사용합니다. 기존 파일이라면 형식과 소유권을 먼저 확인합니다. 셸의 명령 추적(`set -x`)을 켜지 않습니다.

```bash
set -a
. "$HOME/.config/shell-mcp/service.env"
set +a
node dist/cli.js --config config.local.json
```

별도 터미널에서 `curl --fail http://127.0.0.1:8787/health`로 기동을 확인합니다. 이는 인증된 MCP 연결 확인을 대신하지 않습니다. 지속 실행은 [사용자 systemd 안내](OPERATIONS.md#사용자-서비스)를 따릅니다. `deploy/shell-mcp.service`의 WorkingDirectory·ExecStart·config 경로를 실제 설치 위치에 맞추고 `~/.config/shell-mcp/config.json`에 최종 설정을 배치합니다. 예시에 있는 과거 개발자 경로를 그대로 사용하지 않습니다.

원격 A가 접속하려면 B의 [Caddy 예시](../deploy/Caddyfile.example)를 실제 도메인에 맞추고 DNS·TLS·방화벽·프록시를 구성합니다. 외부에 여는 포트는 HTTPS 프록시 포트이며 Node 서버는 `127.0.0.1:8787`에 둡니다. `allowedHosts`에는 프록시를 통해 수신하는 실제 hostname을 넣습니다. Origin을 보내는 클라이언트는 관찰된 정확한 Origin만 allowedOrigins에 추가합니다. 임의 wildcard로 풀지 않습니다.

OAuth를 쓰는 경우 [config.example.json](../config.example.json)과 [운영 안내](OPERATIONS.md#원격-copilot용-oauth-구성)를 사용합니다. issuer/audience/JWKS/subjects/scope와 클라이언트 등록이 필요합니다. 이 서버는 토큰 발급자가 아니며 외부 IdP와 실제 Copilot 로그인은 아직 미검증입니다.

## 4. A의 AI 클라이언트 연결

실제 선택된 harness를 먼저 확인합니다. 다음 두 형식을 섞지 않습니다. 기존 설정에 `shell-mcp` 항목만 병합하고, 같은 이름의 기존 항목이 있으면 내용을 먼저 비교합니다.

| 클라이언트 | 설정 예시 | 설치 위치와 인증 |
| --- | --- | --- |
| VS Code **Local harness** | [vscode-remote.mcp.json](../examples/vscode-remote.mcp.json) | 작업 프로젝트의 `.vscode/mcp.json` 또는 사용자 프로필의 MCP 설정. `servers` 형식, 토큰 비밀번호 입력 |
| VS Code **Copilot harness** | [copilot.mcp.json](../examples/copilot.mcp.json) | 작업 프로젝트의 `.mcp.json` 또는 `$COPILOT_HOME/mcp-config.json`(기본 `~/.copilot/mcp-config.json`). `mcpServers` 형식, 예시는 준비된 OAuth용 |

Local harness 예시의 URL을 B의 실제 HTTPS `/mcp` 주소로 변경하고, B와 동일한 토큰을 개인적인 비밀번호 입력 창에 제공합니다. 토큰을 채팅이나 설정 JSON에 붙여 넣지 않습니다. 토큰 전달은 소유자의 비밀 관리 경로를 사용합니다. Copilot harness에는 `${input:...}` 서버가 전달되지 않으므로 이 예시를 그대로 복사하지 않습니다. OAuth가 준비되지 않았다면 Local harness의 토큰 방식으로 먼저 확인하거나 해당 클라이언트가 지원하는 비밀 헤더 설정을 별도로 준비합니다.

VS Code에서 `MCP: Add Server`의 HTTP 방식으로 등록할 수도 있습니다. URL과 인증·신뢰 설정을 검토한 후 세션의 도구 선택 화면에서 Shell MCP를 활성화하고 `list_targets` 실제 호출을 확인합니다. UI가 재연결/새 세션을 요구하면 그 절차를 수행합니다. 문서 파일을 복사했다고 현재 AI가 즉시 도구를 사용할 수 있다고 가정하지 않습니다.

다른 클라이언트는 자체 MCP 등록 형식을 사용합니다. 공통 계약은 HTTP `/mcp`, `Authorization: Bearer ...`, MCP 도구 발견과 호출입니다. Shell MCP는 AI 모델을 실행하지 않으므로 **별도 AI API 키가 필요하지 않습니다.**

위 형식과 입력 변수의 제약은 2026-10-21 확인한 [VS Code MCP 설정 기준](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)과 [연결 안내](https://code.visualstudio.com/docs/agent-customization/mcp-servers)를 따릅니다. 설치 버전이 다르면 해당 버전 문서와 실제 UI를 확인합니다.

## 5. AI가 처음 호출할 순서

아래는 HTTP 요청 본문이 아니라 **MCP 도구 이름과 arguments**입니다. 클라이언트가 표시하는 도구 접두사는 다를 수 있습니다. 호출 결과는 `structuredContent.result` 또는 JSON text의 `result`에 있으며 오류는 `isError`와 `error.code`로 확인합니다. ID·해시·커서는 실제 반환값을 사용합니다. 예시의 clientRequestId도 설치 시도별 고유 값(예: UUID 접두사)으로 바꿉니다. 같은 작업의 응답 유실을 확인할 때만 기존 ID를 그대로 재사용합니다.

1. 도구 목록을 발견하고 `list_targets({})`를 호출합니다. 현재 버전은 20개 도구입니다.
2. `list_sessions({})`에서 같은 대상의 사용 가능한 소유 세션을 확인합니다. 새 세션이 필요할 때 아래를 호출합니다.

```json
{"tool":"open_session","arguments":{"targetId":"dev-linux","workspaceId":"sample","clientRequestId":"setup-open-001"}}
```

3. 반환된 sessionId로 **별도 두 호출**을 실행해 셸 상태가 유지되는지 확인합니다. 아래의 `SESSION_ID`를 교체하고 명령별 새 요청 ID를 사용합니다.

```json
{"tool":"run_command","arguments":{"sessionId":"SESSION_ID","command":"export SHELL_MCP_SETUP_MARKER=ready; pwd","clientRequestId":"setup-state-001","waitMs":1000}}
```

```json
{"tool":"run_command","arguments":{"sessionId":"SESSION_ID","command":"printf 'marker=%s\\n' \"$SHELL_MCP_SETUP_MARKER\"; pwd","clientRequestId":"setup-state-002","waitMs":1000}}
```

첫 명령의 완료를 확인한 뒤 두 번째를 제출합니다. 각 commandId에 `wait_command`를 적용하고 `read_output`의 stdout/stderr를 조회합니다. 각 스트림의 nextCursor를 그대로 이어 읽습니다. `completed` + exitCode=0과 두 번째 출력의 `marker=ready`, 예상 cwd를 확인합니다. stdout이 비어 있다고 성공을 추측하지 않습니다.

```json
{"tool":"wait_command","arguments":{"commandId":"COMMAND_ID","waitMs":1000}}
```

```json
{"tool":"read_output","arguments":{"commandId":"COMMAND_ID","stream":"stdout","cursor":0,"maxBytes":32768}}
```

stderr도 별도의 cursor=0부터 조회합니다. 실행이 끝났고 nextCursor가 더 진행하지 않으면 해당 스트림 읽기를 마칩니다. outputComplete=false인 원인(진행 중·잘림·불확실성)을 구분합니다.

4. `list_files`/`search_files`/`read_file`로 프로젝트 구조와 테스트 명령을 파악합니다. 사용자 작업이 코드 변경을 포함하면 `read_file` 반환의 `version`을 사용해 다음 형태로 패치합니다. 아래 대문자 값은 템플릿입니다.

```json
{"tool":"apply_patch","arguments":{"sessionId":"SESSION_ID","patch":"--- a/src/example.py\n+++ b/src/example.py\n@@ -1 +1 @@\n-old\n+new\n","expectedVersions":{"src/example.py":"SHA256_FROM_READ_FILE"},"clientRequestId":"task-patch-001"}}
```

5. 같은 sessionId에서 실제 프로젝트 테스트를 실행하고, 필요하면 수정·재실행합니다. 연결 설정만 요청받았다면 파일 변경 대신 읽기 및 위 상태 확인으로 마칩니다. 끝나면 실행 중 작업이 없는 세션을 `close_session`으로 닫습니다.

파일 경로는 등록 workspace 기준입니다. `cd subdir` 뒤에도 `read_file(path="src/example.py")`는 workspace/src/example.py를 뜻합니다. SSH 셸 자체는 파일 도구의 경로 제한으로 격리되지 않으므로 사용자 작업 범위 안에서 실행합니다.

## 6. 끊김·입력·실패 처리

| 상황 | 다음 행동 |
| --- | --- |
| 응답 유실, commandId를 모름 | `get_command`에 sessionId + 기존 clientRequestId. 새 ID로 재실행하지 않음 |
| 명령이 accepted/running | `wait_command`(최대 10초)와 출력 커서 조회. 같은 셸에 두 번째 명령을 제출하지 않음 |
| state=unknown | 성공/실패를 추측하거나 자동 재실행하지 않음. 원격 부작용을 확인하고 사용자 작업 범위에서 판단 |
| 입력 프로그램 | run_command inputMode=pipe → running 확인 → send_input(data, end, clientRequestId). 개행은 직접 포함 |
| 입력 published / unknown | published는 원격 큐 게시만 뜻함. 응답 유실은 같은 요청/내용으로 확인; unknown은 새 ID로 재전송 금지 |
| 취소/시간 초과/SSH 손실 | 셸 상태 손실 가능. broken/closed 세션에 reopen_session 후 새 sessionId 사용, 환경 명시 재준비 |
| 파일 버전 충돌 / partial_apply | 변경 파일을 다시 읽고 실제 상태 확인 후 새 패치 생성 |
| 출력 truncated / 검색 incomplete | 누락을 명시. 더 작은 범위나 더 적은 출력을 요청하여 확인 |

PTY, 화면 앱, sudo 비밀번호 입력, Ctrl+C 전달은 지원하지 않습니다. 입력·출력·재열기 세부 계약은 [V02_USAGE](V02_USAGE.md)를 따릅니다.

## 7. 다른 AI에 전달할 시작 프롬프트

아래를 그대로 전달하고 대괄호 값을 채웁니다. 비밀은 입력하지 않습니다.

```text
https://github.com/lsh235/ssh-mcp 의 AGENTS.md와 docs/AI_SETUP.md를 읽고,
현재 환경에서 가능한 설치·연결 단계를 실제로 진행해.
현재 PC 역할: [A/B/C], B 설치 경로: [절대 경로], MCP 주소: [HTTPS /mcp URL],
B의 SSH 별칭: [별칭], C 프로젝트 경로: [절대 경로],
클라이언트/harness: [제품과 선택된 harness], 인증 방식: [토큰/OAuth].
기존 설정과 다른 서버를 보존하고, 비밀은 채팅에 노출하지 마.
이미 접근 가능한 값은 직접 확인하고 필수 정보만 질문해.
연결 후 실제 list_targets와 두 번의 run_command로 셸 상태 유지를 검증해.
실행할 수 없는 단계는 설정 완료와 구분해서 보고해.
연결 후 개발 작업: [요청할 작업 또는 연결 확인만].
```

원격 프로젝트만 여는 AI에는 이 문서와 원격 사용 규칙도 컨텍스트로 제공해야 합니다. Shell MCP 저장소의 AGENTS.md는 다른 프로젝트까지 자동 적용되지 않습니다. 필요한 지침을 그 프로젝트의 기존 에이전트 지침에 병합합니다.

## 8. 완료 보고와 검증 경계

설치, 서버 기동, HTTPS, 인증된 MCP 호출, B→C SSH, 셸 상태 유지, 실제 클라이언트 호출을 각각 PASS/FAIL/NOT RUN으로 기록합니다. 설정 파일 생성이나 `/health` 응답만으로 전체 성공을 선언하지 않습니다. 외부 HTTPS·IdP·실제 Copilot은 기존 로컬 시험 결과와 별개입니다.

서버 수정 시 `npm run check`와 `npm run smoke`를 실행합니다. 문서/템플릿만 바꿨다면 JSON 형식·서버 설정 스키마·문서 링크를 점검하고 변경 범위에 맞게 실행 확인을 합니다. 테스트 기록은 [V02_STATUS](V02_STATUS.md)에 있습니다.

이 안내의 JSON 예시 6개는 컴파일된 HTTP MCP와 격리된 실제 SSH 서버에서 확인했습니다. 셸 상태 유지와 버전 검사 패치가 통과했으며, 문서 링크·B 설정 스키마·클라이언트 JSON도 검사했습니다. [문서 검증 기록](../test-results/ai-setup/validation.json)을 참조하세요. 실제 Copilot·공개 HTTPS·외부 OAuth 검증은 이 결과에 포함되지 않습니다.

기존 Docker 실습은 [DOCKER_CODEX_DEMO](DOCKER_CODEX_DEMO.md)를 따릅니다. `scripts/mcp-call.mjs`는 `.state/docker-demo/runtime.json` 전용 프로토콜 어댑터이며 일반 원격 설치용 클라이언트가 아닙니다. 이 실습은 추가 AI API 호출 없이 현재 AI가 HTTP MCP를 사용한 증거이고, 네이티브 클라이언트 등록 검증과는 별개입니다. 재실습 로그는 `SHELL_MCP_TRANSCRIPT_DIR=test-results/private/내-실습`처럼 비공개 경로에 보관합니다.
