# Shell MCP 상세 설계

작성 기준: 2026-10-21, Asia/Seoul. 문서의 API·기본값·버전 계획은 제안이며 구현 사실이 아닙니다.

> 이 문서는 구현 전 설계 기록입니다. 이후 사용자의 개발 지시에 따라 v0.1을 구현했습니다. 현재 동작·설계 대비 변경·검증 결과는 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), 실행 방법은 [OPERATIONS.md](OPERATIONS.md)를 기준으로 확인하세요. 아래의 NOT RUN 표는 설계 당시 상태를 보존한 것입니다.

## 1. 확정 요구사항

사용자는 다음 배치를 선택했습니다.

- A: VS Code와 Copilot이 실행되는 사용자 PC.
- B: 원격 MCP 서버가 설치되는 PC. 이 PC의 SSH 설정·키·agent를 이용합니다.
- C: 실제 코드와 실행 환경이 있는 SSH 작업 대상 PC.

A는 B의 MCP 주소에 접근합니다. B가 C에 직접 SSH로 접속하고 명령을 실행합니다. 기존 Tabby 플러그인을 호출하는 중계 경로는 실행 의존성에 포함하지 않습니다.

제품의 핵심은 **명령 요청이 끝나도 SSH 연결과 그 안의 셸 프로세스를 유지하는 것**입니다. Copilot은 원격 소스와 실행 결과를 읽어 수정 방향을 결정합니다. MCP 서버 자체에는 LLM이나 별도 OpenAI API가 필요하지 않습니다.

설계 범위는 첫 버전과 후속 확장 1회까지입니다. 이번 작업은 문서와 구조도 작성까지이며, 서버 구현·실제 원격 접속·포트 개방·커밋·배포를 수행하지 않습니다.

## 2. 연결 및 배포

```text
A: VS Code / Copilot
        │ HTTPS /mcp · Streamable HTTP
        ▼
B: TLS 진입점 → 인증·대상 권한 → MCP 도구 → 세션 관리자
                                               │
                          ┌────────────────────┴──────────────────┐
                          ▼                                       ▼
                 OpenSSH 어댑터                         명령 상태·결과 저장소
                          │ SSH / 기존 포트
                          ▼
C: sshd → 세션 전용 Bash worker → 프로젝트·빌드·테스트
           ├─ 동일 셸에서 cd / export / source 유지
           └─ 임시 명령 스크립트·출력 파일·완료 레코드
```

B는 사용자 네트워크에서 접근 가능한 HTTPS 포트 하나를 제공합니다. 기본 제안은 443이며, 예를 들어 내부 MCP 프로세스는 B의 `127.0.0.1:8787`에 바인딩하고 같은 PC의 리버스 프록시가 TLS를 처리합니다. 프록시 없이 서버가 직접 TLS를 종료하는 배치도 가능합니다. 포트를 열기만 하면 인증이 생기는 것은 아니므로 MCP 인증을 함께 구성합니다.

C는 B에서 기존 SSH 포트(통상 22, 대상별 설정 가능)에 도달할 수 있어야 합니다. C에는 MCP나 HTTP 수신 포트가 필요하지 않습니다. 첫 버전은 B와 C 모두 Linux, C에 Bash·OpenSSH 서버·SFTP·표준 파일 유틸리티와 `setsid`가 있는 환경을 기준으로 합니다. C의 `MaxSessions` 등 SSH 설정은 셸과 보조 파일 채널을 허용해야 합니다.

권장 초기 설치는 B의 **SSH 설정을 사용할 실제 사용자 계정으로 실행하는 systemd 사용자 서비스**입니다. root 서비스나 컨테이너가 로그인 사용자의 agent·홈 디렉터리를 자동으로 공유한다고 가정하지 않습니다. 컨테이너 배치는 agent 소켓·설정 경로·UID가 복잡해지므로 첫 검증 후 확장합니다.

## 3. 기술 선택

| 항목 | 제안 | 선택 이유 |
| --- | --- | --- |
| 서버 | TypeScript + 지원 중인 Node.js LTS | 두 저장소의 타입·도구 구조를 활용하기 쉬움 |
| MCP | 공식 TypeScript SDK의 지원 버전, Streamable HTTP | 원격 URL로 직접 연결 |
| SSH | B의 시스템 OpenSSH | B의 config·agent·키·ProxyJump 동작을 최대한 보존 |
| 기본 셸 | 지속되는 비 PTY Bash worker | 셸 상태 유지와 출력·완료 정보 분리 |
| 파일 접근 | 같은 SSH master의 SFTP/보조 명령 채널 | 원격 코드를 직접 읽고 수정 |
| 명령 메타데이터 | B의 SQLite | 접수 여부·실행 상태·중복 방지 기록 |
| 출력 | C의 명령별 임시 파일 → B의 제한된 로그 저장소 | 긴 출력과 HTTP 재접속 처리 |
| 서비스 | B의 systemd 사용자 서비스 | 계정·인증정보의 경계를 명확히 유지 |

SDK, Node.js, OpenSSH의 정확한 버전은 구현 시작 시 고정하고 실제 VS Code 빌드와 함께 기록합니다. 기존 플러그인의 SDK 1.8.0을 그대로 신규 서버의 기반으로 고정하지 않습니다.

## 4. 오픈소스 재사용 경계

### Tabby

확인한 Tabby의 SSH 코어는 `russh`를 사용하며, SSH 연결 객체와 셸 채널 객체를 분리합니다. 이를 근거로 새 서버에서도 `Connection`과 `ShellSession`을 별도 개념으로 둡니다. Angular 서비스와 Electron UI에 묶인 코드를 그대로 가져오는 것은 피합니다. [확인한 SSH 연결 소스](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/ssh.ts), [셸 소스](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/shell.ts).

첫 이식 후보는 `shellChannel.ts`의 터미널 타입 정규화 규칙과 `SSHProfile`의 관련 필드입니다. 연결 참조·채널 종료·출력 구독 순서와 같은 생명주기 설계도 반영합니다. 타입과 순수 로직을 추출·적응하는 방식이며, OpenSSH가 담당하는 인증 알고리즘을 Tabby 코드로 중복 구현하지 않습니다. PTY 관련 이식은 후속 PTY 기능에 사용합니다.

### tabby-mcp-server

`exec_command`, 결과 ID와 출력 페이지 조회, 명령 이력의 개념 및 타입은 새 도구 계약의 출발점으로 사용합니다. 저장소 구현에서 Angular DI와 화면 관련 의존성을 제거하고 소유자·세션·명령 범위를 추가합니다. 결과 ID와 페이지 조회는 활용하되 저장소의 현재 메모리 보관 정책은 새 서버의 내구성 요구에 맞게 바꿉니다. [출력 저장소](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/services/commandOutputStorage.service.ts), [조회 도구](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/tools/terminal/get-command-output-tool.ts).

현재 `exec-command-tool.ts`는 Tabby 탭 입력·버퍼 읽기·서브셸 래핑·자동 재시도와 UI에 결합되어 있습니다. 이 부분은 새 실행기로 교체합니다. 확인한 원본은 매번 서브셸로 감싸므로 그 내부의 `cd`와 `export`를 다음 요청까지 유지하는 근거가 되지 않습니다. [명령 실행부](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/tools/terminal/exec-command-tool.ts).

두 프로젝트 모두 조사 시점에 MIT로 표시되어 있습니다. 실제 이식 시 파일별 출처·리비전·수정 내역과 원본 고지를 기록합니다. 이 문서는 전체 의존성의 라이선스 검토 완료를 의미하지 않습니다.

## 5. SSH 인증정보 처리

MCP 도구는 임의의 개인키 본문·비밀번호·agent 소켓 경로를 인자로 받지 않습니다. 관리자가 B에서 등록한 `targetId`만 선택합니다.

```yaml
# 설계 예시. 아직 동작하는 설정 파일은 아닙니다.
targets:
  dev-linux:
    sshAlias: dev-linux
    workspaceRoots:
      - /srv/projects/sample
    shell: bash
    credentialSource: service-user-openssh
```

B의 해당 사용자 계정에 이미 다음 정보가 있다고 가정합니다.

```sshconfig
Host dev-linux
    HostName 10.20.0.15
    User developer
    Port 22
    IdentityFile ~/.ssh/id_ed25519_dev
    IdentitiesOnly yes
    # 필요한 환경에서는 관리자가 ProxyJump를 지정
```

접속기는 OpenSSH를 인자 배열로 실행해 등록된 별칭을 사용합니다. `BatchMode=yes`, 사전에 등록한 known_hosts와 `StrictHostKeyChecking=yes`, `ForwardAgent=no`, `ForwardX11=no`를 기본으로 강제합니다. agent로 **B에서 인증**하는 것과 agent를 **C에 전달**하는 것은 구분합니다. [OpenSSH 설정](https://man.openbsd.org/ssh_config), [OpenSSH 사용법](https://man.openbsd.org/ssh).

같은 사용자로 서비스가 실행되고 올바른 `SSH_AUTH_SOCK`에 접근할 수 있어야 로그인 터미널에서 쓰던 agent를 사용할 수 있습니다. 서비스 시작 시 확인 결과만 반환하고 키·소켓 상세나 설정 전문을 모델에 내보내지 않습니다. 잠긴 키·만료된 agent·새 host key·MFA 요구는 `AUTH_REQUIRED` 또는 `HOST_KEY_UNTRUSTED`로 보고하고 관리자가 B에서 준비합니다. 비밀번호 및 MFA 대화형 처리는 첫 버전 범위 밖입니다.

등록된 config의 `ProxyCommand`, `LocalCommand`, `Match exec` 같은 동작은 관리자 신뢰 설정입니다. 모델이 이를 새로 삽입하거나 임의 `-o` 옵션을 넘기지 못하게 합니다. wildcard 설정은 작업 대상 목록으로 자동 공개하지 않습니다.

인증된 SSH 연결은 별도 프로세스의 기존 로그인 화면을 인계받는 의미가 아닙니다. B의 인증 수단을 이용해 MCP 전용 연결을 만들고 관리합니다. 첫 버전에서는 MCP 전용 `ControlPath`를 사용해 일반 사용자의 다른 SSH master와 섞지 않습니다.

## 6. 연결·셸·MCP 요청의 수명 분리

| 개념 | 의미 | 보관 위치 |
| --- | --- | --- |
| HTTP 요청/응답 스트림 | MCP 메시지를 전달하는 통신 | A ↔ B |
| MCP 프로토콜 컨텍스트 | 사용한 프로토콜 리비전에 따른 기능·호환 처리 | B의 전송 어댑터 |
| SSH connection | 인증된 네트워크 연결과 master 프로세스 | B ↔ C |
| shell session | 같은 cwd·환경·함수를 유지하는 Bash 프로세스 | C |
| command | 접수·실행·결과 상태를 가진 개별 작업 | B 메타데이터 + C 실행 |

HTTP가 끊겨도 서버가 소유한 셸을 즉시 파괴하지 않습니다. 새 MCP 연결에서도 같은 인증 주체가 `sessionId`로 재조회합니다. ID 자체는 접근 권한이 아니며, 모든 호출에서 소유자와 대상 권한을 다시 검사합니다.

2026-07-28 MCP 사양은 프로토콜 수준 세션을 제거했고 이전 리비전과 전송 동작도 다릅니다. 따라서 제품의 `sessionId`는 자체 도구 인자로 유지하고, `Mcp-Session-Id`에 의존하지 않습니다. 실제 VS Code/SDK 조합에서 지원되는 리비전을 검증하고 필요한 이전 리비전 지원은 전송 계층으로 격리합니다. 단순히 최신 날짜를 하드코딩하지 않습니다. [현재 Streamable HTTP 사양](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [이전 리비전](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

최신 HTTP 사양에서 응답 스트림 종료가 요청 취소로 취급되는 점도 반영합니다. `run_command`는 명령을 영속적으로 접수하고 짧게 응답하는 제출 작업입니다. 접수 완료 후 실행은 별도 애플리케이션 작업이며 `get_command`로 조회하고 `cancel_command`로 명시적으로 중단합니다. 접수 도중 응답이 유실되면 요청 키로 접수 여부를 조회합니다. 조회 요청 취소와 이미 접수된 작업 중단을 혼동하지 않습니다.

## 7. 지속 셸 실행 방식

### 기본: managed 모드

첫 버전은 일반 빌드·테스트·소스 수정에 적합한 비 PTY 관리 셸입니다.

1. B가 세션 전용 OpenSSH master를 만들고 같은 연결의 채널들을 관리합니다.
2. C의 사용자 전용 임시 디렉터리 아래에 짧은 Bash worker·명령 파일·결과 파일을 준비합니다. 디렉터리는 0700, 민감한 파일은 0600으로 생성합니다.
3. worker는 한 번 시작한 Bash에서 대기합니다. 요청별 스크립트를 **같은 셸의 `source`/동등한 평가 방식**으로 실행합니다. 명령 전체를 새 서브셸로 감싸지 않습니다.
4. 일반 명령의 stdin은 기본 `/dev/null`로 두고 명령 전달용 스트림과 분리합니다. 기본 모드는 사용자 입력 대기 작업을 지원하지 않습니다.
5. stdout/stderr는 명령별 파일에 기록합니다. B는 같은 SSH master의 보조 파일 채널로 로그를 수집하고 제한된 크기로 돌려줍니다. 사용자 프로그램 출력에서 완료 표식을 찾아 종료를 추측하지 않습니다.
6. worker는 정상 복귀 시 종료 코드, cwd와 세션 세대 정보를 별도 완료 레코드에 임시 쓰기 후 rename합니다. 해당 레코드를 확인해야 명령을 완료로 처리합니다.

ControlMaster는 연결 공유 기능이며 그 자체로 셸 상태를 보존하지 않습니다. 지속 셸은 2~3번에서 별도로 유지해야 합니다. 보조 명령은 master 소켓이 없을 때 새 연결로 조용히 fallback하지 않도록 실행기를 제한하고, 세션 세대와 worker 생존 확인 후만 기록을 인정합니다. [OpenSSH의 연결 공유 동작](https://man.openbsd.org/ssh_config).

세션에서 다음을 각각 별도의 `run_command`로 보내도 상태가 이어져야 합니다.

```text
1) cd /srv/projects/sample
2) export APP_ENV=test; source .venv/bin/activate
3) python -m pytest -q
```

기본 셸은 예측 가능한 Bash 실행 옵션으로 시작하고, 필요 환경은 명시적인 초기화 스크립트 또는 명령으로 준비합니다. 사용자의 화면용 프롬프트·터미널 버퍼를 실행 프로토콜로 사용하지 않습니다.

`exit`, `exec`, 셸 종료 신호, `set -e` 등으로 worker가 종료되면 상태 유지가 끝납니다. 제어용 FD나 worker 내부 변수를 변경하는 명령도 프로토콜을 깨뜨릴 수 있으므로 예약 영역을 문서화하고 비정상 종료를 탐지합니다. 같은 OS 계정의 명령은 worker 파일에 접근할 수 있으므로 이 프로토콜은 악성 작업을 격리하는 보안 경계가 아닙니다.

background 프로세스가 계속 파일에 쓰는 경우 전경 명령 완료가 전체 로그 최종화를 뜻하지 않습니다. 첫 버전은 전경 작업을 기준으로 하며 백그라운드 서비스 감독은 후속 범위입니다. 큰 출력·디스크 부족·채널 유실 시 `outputComplete=false`와 상태를 명시합니다.

### 확장: interactive 모드

후속 버전에서는 Tabby의 셸/PTY 분리와 터미널 타입 정규화 규칙을 활용해 PTY를 지원합니다. `send_input`, Ctrl+C, 터미널 크기 변경, 원시 출력 조회를 추가합니다. PTY에서는 stdout/stderr가 합쳐질 수 있고, 사용자 프로그램의 입력 대기와 명령 완료를 별도 상태로 취급해야 합니다. 자동 빌드·테스트 모드와 대화형 터미널 모드의 결과 보장은 구분합니다.

첫 버전의 managed 모드에서 `sudo` 비밀번호, REPL, `vim`, `top`, 입력을 요구하는 설치 프로그램은 지원 대상이 아닙니다. 잘못 보낸 경우 deadline과 취소 도구로 회수합니다.

## 8. MCP 도구 계약

모든 ID는 추측하기 어려운 값으로 생성합니다. 응답은 구조화된 데이터와 짧은 텍스트 요약을 제공하며, 도구 실패와 원격 프로그램의 비영 종료 코드는 구분합니다.

| 도구 | 주요 입력 | 결과 / 용도 |
| --- | --- | --- |
| `list_targets` | 없음 | 현재 주체가 접근 가능한 targetId와 공개 설명 |
| `open_session` | targetId, workspaceId, clientRequestId | sessionId, generation, cwd, mode, capabilities |
| `list_sessions` | 선택 필터 | 자신의 세션과 상태 조회 |
| `get_session` | sessionId | 연결·셸·진행 명령·마지막 cwd |
| `close_session` | sessionId | 실행 중이면 명시적 취소 필요 여부, 종료 결과 |
| `run_command` | sessionId, command, clientRequestId, waitMs, deadlineMs | commandId, 상태, 출력 일부, 확인된 종료 코드 |
| `get_command` | commandId 또는 sessionId + clientRequestId | 접수 여부, 실행 상태, 완료 정보 |
| `read_output` | commandId, stream, cursor, maxBytes | 출력 페이지, nextCursor, truncated, outputComplete |
| `cancel_command` | commandId | 취소 요청 상태, 프로세스 종료 확인, 셸 손실 여부 |
| `list_files` | sessionId, 상대 경로, cursor | 제한된 디렉터리 목록 |
| `read_file` | sessionId, 상대 경로, offset, maxBytes | 내용, 파일 버전 해시, 인코딩 |
| `apply_patch` | sessionId, patch, expectedVersions, clientRequestId | 변경 파일·새 해시·충돌·부분 적용 여부 |
| `git_status` | sessionId | 변경 경로와 저장소 상태 |
| `git_diff` | sessionId, 경로 필터 | 제한된 크기의 diff |

workspaceId는 B의 등록된 root를 가리킵니다. 모델이 서버에서 임의 경로를 root로 추가하지 못하게 합니다. `sessionId`와 `targetId`를 함께 전달하는 도구가 생기면 일치 여부를 검증합니다.

`run_command` 예시:

```json
{
  "sessionId": "s_example",
  "command": "python -m pytest -q",
  "clientRequestId": "test-after-patch-003",
  "waitMs": 1000,
  "deadlineMs": 120000
}
```

접수 후 응답 예시:

```json
{
  "sessionId": "s_example",
  "generation": 1,
  "commandId": "c_example",
  "state": "running",
  "exitCode": null,
  "outputPreview": "",
  "nextCursor": null,
  "outputComplete": false,
  "cwd": "/srv/projects/sample",
  "cwdObservedAt": "before_command"
}
```

완료 결과에는 `state=completed`, 실제 `exitCode`, stdout/stderr 미리보기, 다음 커서, `outputComplete`, 시작/종료 시각을 반환합니다. 완료가 확인되기 전에는 종료 코드를 0으로 채우지 않습니다. `completed`는 실행 완료이며 테스트 성공과 동의어가 아닙니다.

## 9. 동시 실행·재시도·장애

### 동시성

동일 셸에서는 하나의 명령만 실행합니다. 실행 중 새 명령은 `SESSION_BUSY`와 진행 중 commandId를 반환합니다. 기존 명령을 자동 중단하지 않습니다. 파일 수정 역시 같은 workspace의 서버 내부 잠금과 명령 상태를 확인해 테스트 도중 코드를 바꾸지 않도록 합니다. 읽기·출력 조회는 허용합니다.

별도 세션은 병렬 실행할 수 있지만, 같은 디렉터리를 변경하면 서로 간섭할 수 있습니다. 첫 버전은 같은 workspace의 쓰기·실행을 단일 소유로 제한하고, 후속 병렬 개발은 별도 git worktree/root를 등록하는 방식으로 확장합니다. 이 서버 밖에서 수행하는 편집과 명령에는 서버 내부 잠금이 적용되지 않습니다.

### 중복 실행 방지

서버는 `(principal, sessionId, clientRequestId)`와 명령 내용 해시를 SQLite에 먼저 기록합니다. 같은 키·같은 내용이면 기존 commandId를 반환하고, 다른 내용이면 `REQUEST_CONFLICT`를 반환합니다. `open_session` 등 자원을 만드는 작업에도 요청 키를 둡니다.

접수·원격 전달·완료 기록 사이에는 장애 구간이 있습니다. 결과를 확정할 수 없으면 `unknown`으로 남기고 조회·조사를 허용합니다. 실행됐을 가능성이 있는 명령은 자동 재전송하지 않습니다. 임의 SSH 명령의 exactly-once를 보장한다고 주장하지 않습니다.

### 상태

```text
session: opening → ready ⇄ busy → closed
                     └─ SSH/worker 손실 → broken
command: accepted → running → completed
                    ├─ cancel_requested → cancelled 또는 unknown
                    ├─ deadline 초과 → timed_out 또는 unknown
                    └─ 상태 확인 불가 → unknown
```

명령 실패는 `completed + exitCode != 0`이며, 전송 실패·연결 손실과 다릅니다. `broken` 세션에 재연결해도 과거 Bash의 환경을 복구했다고 표시하지 않습니다. 새 세션/세대를 만들고 환경 초기화부터 다시 수행합니다.

### 취소와 시간 초과

managed worker는 전용 OS 세션/프로세스 그룹에서 실행합니다. 첫 버전의 강제 취소는 보조 SSH 채널에서 해당 그룹을 종료하므로 셸 상태도 손실될 수 있습니다. 이때 세션을 닫고 `shellStatePreserved=false`를 반환합니다. 셸을 살려 둔 채 임의 명령을 항상 안전하게 중단할 수 있다고 약속하지 않습니다.

종료 확인이 불가능하면 `cancel_requested/unknown`으로 보고합니다. SSH 연결을 닫았다는 사실만으로 C의 모든 프로세스가 종료됐다고 보고하지 않습니다. 프로세스 그룹에서 이탈한 작업은 별도 감독 없이는 완전 회수가 불가능하므로 첫 버전은 신뢰된 전경 개발 작업을 대상으로 합니다.

### 수명 제안

- 짧은 도구 대기: 기본 1초, 최대 10초. 이후 commandId로 조회.
- 명령 deadline: 기본 2분, 관리자가 허용하는 상한 30분.
- 셸 idle lease: 기본 30분. 실행 중에는 idle 만료를 적용하지 않음.
- SSH keepalive: 예를 들어 15초/3회. 실행 제한 시간과는 별개.
- 로그: 명령당 10 MiB 기본 상한, 페이지당 32 KiB, 보관 24시간.

이 수치는 초기 정책 후보입니다. 출력 크기 한도에 도달하면 수집을 멈추고 잘림을 표시하며, C의 spool도 한도를 넘지 않도록 제한해야 합니다. 단순히 MCP 응답만 자르고 원격 디스크는 무제한 소비하게 만들지 않습니다.

B 프로세스 재시작 후 SQLite의 기록과 로그는 조회할 수 있지만 기존 메모리의 연결·셸은 복구 보장 대상이 아닙니다. 완료가 불명확한 명령을 `unknown`으로 조정하고, 남아 있는 임시 파일·프로세스를 제한된 복구 절차로 확인합니다. C의 임시 디렉터리는 활성 세션 확인 후 정리하며 무조건적인 광역 삭제를 하지 않습니다.

## 10. 원격 파일 수정과 개발 루프

코드 기준본은 C입니다. Copilot의 로컬 편집 기능을 사용하면 로컬 파일만 바뀔 수 있으므로 서버 도구 설명과 사용 안내에 원격 파일 도구를 명시합니다. MCP는 VS Code 탐색기를 자동으로 원격 파일 시스템으로 바꾸지 않습니다.

기본 루프:

1. `list_targets` → `open_session`으로 대상과 workspace 확인.
2. `git_status`, `list_files`, `read_file`로 코드와 기존 변경 확인.
3. Copilot이 수정안을 만들고 읽은 파일의 해시를 포함해 `apply_patch` 호출.
4. 파일 버전이 바뀌었으면 `VERSION_CONFLICT`를 받아 재조회.
5. 같은 sessionId에서 환경 준비 후 테스트 실행.
6. `get_command`/`read_output`으로 결과 확인, 실패 시 2~5 반복.
7. `git_diff`로 변경과 테스트 결과를 사용자에게 제시.

경로는 등록된 root 기준 상대 경로로 받습니다. 경로 탈출, 심볼릭 링크를 통한 root 외부 접근, NUL 등을 거부합니다. 파일 크기·개행·인코딩·실행 권한을 보존하고 첫 버전은 일반 텍스트 파일만 편집합니다. 바이너리와 특수 파일은 거부합니다.

패치는 서버 내부 잠금 아래에서 사전 해시·전체 patch 적용 가능 여부를 먼저 검사하고, 파일별 임시 쓰기 후 rename합니다. 여러 파일을 모두 원자적으로 바꾸는 트랜잭션은 보장하지 않습니다. 중간 오류는 `partial_apply`와 적용 파일 목록을 반환합니다. 외부 편집자와 완전한 CAS를 제공하는 것도 아니므로 원격 개발용 전용 worktree를 권장하고, 최종 diff를 다시 확인합니다.

파일 도구의 root 제한은 임의 셸 명령의 OS 접근 권한을 제한하지 않습니다. 진짜 격리가 필요하면 C의 전용 계정·컨테이너·파일 권한으로 집행합니다.

## 11. MCP 인증과 권한

MCP 로그인과 C의 SSH 로그인은 별도 경계입니다. A는 B에 인증하고, B는 자기 자격증명으로 C에 인증합니다.

권장 배치는 TLS + MCP HTTP 인증 흐름에 맞춘 OAuth입니다. B를 리소스 서버로 두고 기존 IdP를 사용하며, 클라이언트에 인증 메타데이터를 제공합니다. access token의 발급자·대상·만료·서명을 검증하고 주체를 허용된 target/workspace에 매핑합니다. 첫 버전은 단일 소유자·단일 OS 실행 계정으로 한정합니다. [MCP 인증 사양](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

첫 버전부터 다음을 적용합니다.

- 인증 없는 명령·파일 도구 호출 차단. sessionId·commandId·output cursor별 소유자 검사.
- `Origin`이 제공되면 허용된 값인지 검사하고, 잘못된 Host/Origin을 거부.
- B의 관리 설정 변경 기능은 모델 도구로 공개하지 않음.
- 임의 셸 실행은 본질적으로 C 계정의 권한을 사용함. 명령 문자열 denylist를 격리 수단으로 간주하지 않음.
- 원격 로그·소스는 신뢰되지 않은 작업 데이터. 도구 결과의 문구로 서버 권한이나 사용자의 요청을 변경하지 않음.
- 감사 로그에 주체·대상·세션·명령 ID·상태·시간을 남기고, 토큰·키·환경변수 전체는 기록하지 않음.
- stdout/stderr에는 비밀이 나올 수 있으므로 명령 실행 계정과 로그 보관 권한을 제한. 마스킹은 완전한 유출 방지 수단이 아님.

다중 사용자 지원은 주체별 OS 계정/worker와 credential 경계를 분리하는 후속 작업입니다. 호스트명·포트·SSH 사용자만 같다는 이유로 다른 주체의 연결을 공유하지 않습니다.

## 12. VS Code Copilot 연결 예시

현재 VS Code 공식 문서는 portable Copilot 설정과 VS Code 자체 설정을 구분합니다. Copilot harness용 portable 예시는 아래와 같습니다. 인증은 서버의 OAuth 흐름으로 처리하며 토큰을 예시에 적지 않습니다. [VS Code 설정 형식](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

```json
{
  "mcpServers": {
    "shell-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

이는 프로젝트 루트 `.mcp.json` 또는 개인 Copilot 설정의 형태이며, `mcp.example.com`은 교체할 예시 주소입니다. 실제 저장 위치와 지원 여부는 사용 중인 VS Code 버전·harness로 확인해야 합니다.

VS Code Local harness의 `.vscode/mcp.json`을 쓰는 환경은 최상위 키가 다릅니다.

```json
{
  "servers": {
    "shell-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

현재 문서상 `${input:...}`를 요구하는 서버는 Copilot harness에 전달되지 않으므로, 입력 프롬프트 기반 bearer token 예시를 Copilot 공통 설정으로 제시하지 않습니다. 서버 추가 뒤 실제 도구 호출과 반환 내용을 확인해야 연결이 검증됩니다. [서버 추가 및 검증 안내](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## 13. 구현 모듈 계획

```text
src/
  server/       MCP 전송·인증·도구 등록
  targets/      관리자 등록 대상과 workspace 해석
  ssh/          OpenSSH 프로세스·master·보조 채널
  sessions/     소유자·세대·지속 셸·직렬 실행
  runner/       C에 전달할 Bash bootstrap와 결과 계약
  commands/     접수·요청 키·상태·취소
  workspace/    파일 읽기·패치·git 조회
  storage/      SQLite 메타데이터·제한된 출력 보관
  audit/        비밀을 제외한 실행 추적
  upstream/     선별 이식 로직과 원본 고지
```

이 디렉터리는 계획이며 현재 생성한 실행 코드가 아닙니다. Tabby UI나 플러그인을 백그라운드에서 띄우는 모듈을 넣지 않습니다.

## 14. 한정된 개발 순서와 완료 판정

실제 구현을 시작할 때 v0.1 범위를 아래 네 단계로 고정합니다. 각 단계는 최대 2회의 보완 후 동일 기준으로 재검증하고, 계속 실패하면 해당 기준을 FAIL/NOT RUN으로 두고 v0.1 NO-GO를 보고합니다. 자동으로 새 버전이나 백로그를 추가하지 않습니다.

| 단계 | 범위 | 통과 기준 |
| --- | --- | --- |
| 1 | MCP HTTP·인증·대상 등록 | 실제 Copilot의 대상 조회, 인증 실패 차단 |
| 2 | OpenSSH·managed 지속 셸·명령 추적 | 세 요청 사이 cwd·환경·가상환경 유지, 장시간 명령 조회 |
| 3 | 파일 읽기·패치·개발 루프 | 실패 테스트를 원격 수정 후 통과, diff·버전 충돌 확인 |
| 4 | 재접속·중복 방지·취소·패키징 | HTTP 유실·SSH 단절·재시작·출력 한도·권한 음성 시나리오 검증 |

후속 v0.2 후보는 PTY 대화형 입력과 제한된 세션 복구입니다. Windows/PowerShell, 다중 사용자, 영속 터미널(tmux 등), 로컬↔원격 자동 동기화, 공개 서비스 운영은 별도 요구사항과 검증 없이는 v0.1에 포함하지 않습니다.

## 15. 수용 시나리오와 현재 검증 상태

| ID | 검증 시나리오 | 기대 결과 | 현재 |
| --- | --- | --- | --- |
| A01 | 실제 VS Code Copilot에서 B의 HTTPS MCP 호출 | 지정 도구 호출과 원격 결과가 대화에 반영 | NOT RUN |
| A02 | B의 config·키·agent와 ProxyJump로 C 접속 | 노트북 키 전달 없이 허용 대상 접속 | NOT RUN |
| A03 | 세 개의 별도 명령으로 cd / export / source / 실행 | cwd·환경·가상환경 일치 | NOT RUN |
| A04 | 2분 이상 테스트 실행 후 여러 차례 출력 조회 | 셸 유지, 결과와 종료 코드 확인 | NOT RUN |
| A05 | 원격 파일 읽기·패치·실패 테스트 수정 | 같은 sessionId로 최종 성공과 diff 제시 | NOT RUN |
| A06 | 접수 직후 HTTP 단절과 같은 요청 키 재호출 | 원격 부작용 중복 실행 없음 | NOT RUN |
| A07 | 명령 중 SSH 네트워크 단절 | unknown/broken 표시, 자동 재실행 없음 | NOT RUN |
| A08 | 타 주체의 세션·출력 ID 접근 | 거부, 내용 유출 없음 | NOT RUN |
| A09 | known_hosts 불일치·agent 부재 | 구체적인 실패, 신뢰 자동 우회 없음 | NOT RUN |
| A10 | 파일 해시 충돌·경로 탈출·외부 링크 | 수정 거부 및 원인 반환 | NOT RUN |
| A11 | 명령 종료 7·worker exit·시간 초과·취소 | 실패 종류 구분, 0으로 오인하지 않음 | NOT RUN |
| A12 | 같은 셸에 동시 명령 2개 | 두 번째는 busy, 기존 명령 유지 | NOT RUN |
| A13 | 대용량 로그·디스크 한도·재시작 | 명시적 잘림·불완전 상태, 무제한 증가 방지 | NOT RUN |
| A14 | 여러 파일 패치 중 오류·외부 파일 수정 | 부분 적용/충돌 명시, 조용한 덮어쓰기 방지 | NOT RUN |

설계 문서와 구조도의 검증은 제품 실행 검증을 대체하지 않습니다. 지금은 위 시나리오를 실행하지 않았으므로 제품 출시 판정은 **NO-GO**입니다. 구현 후 핵심 기능과 장애/권한 시나리오를 실제 B·C 및 실제 Copilot에서 통과시켜야 GO로 바꿀 수 있습니다.
