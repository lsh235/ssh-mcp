# SSH 접속 후 추가 로그인 입력 자동화 (v0.3)

SSH 인증에 성공한 다음 별도의 로그인·보안 게이트에서 입력을 요구하는 대상을 지원합니다. 대상별 `postLogin`을 설정하면 `open_session`이 안내 문구를 기다렸다가 **값 + Enter**를 순서대로 보내고, 셸 준비 확인까지 끝낸 후 세션을 반환합니다. AI에게 비밀을 도구 인자로 넘길 필요가 없습니다.

```text
SSH 키/agent 인증 → 로그인 안내 1 → 값 1 + Enter
                 → 로그인 안내 2 → 값 2 + Enter
                 → 셸 준비 문구 확인 → 개발용 지속 Bash 시작
```

실제 사용자의 입력값은 코드·예시·시험 자료에 저장하지 않았습니다. 예시 주소·경로·안내 문구는 실제 값으로 바꿉니다. **이 기능은 SSH 자체의 비밀번호·keyboard-interactive·MFA 인증과 별개**입니다. 최초 SSH 인증은 여전히 B의 기존 키/agent와 엄격한 host-key 검증을 사용합니다.

## 대상 설정 파일

전체 형식은 [config.post-login.example.json](../examples/config.post-login.example.json)에 있습니다. 기존 대상에 아래 `postLogin`만 추가할 수도 있습니다.

```json
{
  "postLogin": {
    "steps": [
      { "expect": "Login ID:", "valueFrom": { "file": "/home/mcp/.config/shell-mcp/gate-user" } },
      { "expect": "Access phrase:", "valueFrom": { "file": "/home/mcp/.config/shell-mcp/gate-password" } }
    ],
    "ready": "GATE_READY> ",
    "lineEnding": "lf",
    "timeoutMs": 10000
  }
}
```

| 설정 | 동작 |
| --- | --- |
| `steps` | 1~8단계. 각 expect를 확인한 뒤 해당 값을 한 번만 보냄 |
| `expect` | 정규식이 아닌 리터럴 부분 문자열(1~256자). ANSI 제어문자와 CR 정규화 후 비교 |
| `valueFrom.file` | B 서비스 계정 소유의 비공개 UTF-8 일반 파일 절대 경로. symlink·그룹/다른 사용자 권한 거부 |
| `valueFrom.env` | 파일 대신 B 서버 프로세스 환경에서 읽음. 예: `{"env":"GATE_LOGIN_PASSWORD"}` |
| `ready` | 마지막 입력 후 사용할 수 있는 셸을 확인할 리터럴 문구. 입력값과 구분되는 명확한 프롬프트 사용 |
| `lineEnding` | 값 뒤에 붙일 Enter. 기본 `lf`, 필요하면 `cr` 또는 `crlf`. 자동 감지·재전송 없음 |
| `timeoutMs` | 안내 문구별 및 셸 준비 대기 제한. 기본 10초, 최대 30초. 전체 단계 합계는 더 길 수 있음 |

`valueFrom`에는 file/env 중 하나만 허용합니다. `value` 같은 인라인 비밀 설정은 거부합니다. ready에는 단순 `>`나 `$`처럼 넓은 문자열을 피하고 실제 화면의 안정적인 문구를 사용합니다. 같은 MCP에서 일반 SSH 대상과 추가 로그인 대상을 함께 사용할 수 있습니다. postLogin을 생략하면 기존 접속 방식을 사용합니다.

설정은 서버 시작 시 읽습니다. 변경 후 실행 중 작업을 확인하고 재시작해야 하며, 재시작하면 기존 셸 상태를 유지하지 않습니다.

## 비밀 파일 준비

B에서 서비스 계정으로 실행합니다. 아래는 화면에 값을 표시하지 않는 터미널 입력 방식입니다. 실제 비밀을 명령줄·채팅·Git에 쓰지 않습니다. 기존 파일은 덮어쓰지 않습니다.

```bash
install -d -m 700 "$HOME/.config/shell-mcp"
python3 - <<'PY'
from pathlib import Path
import getpass, os
directory = Path.home() / '.config/shell-mcp'
for name in ('gate-user', 'gate-password'):
    value = getpass.getpass(name + ': ')
    if len(value.encode('utf-8')) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise SystemExit('A printable single line of at most 1024 bytes is required')
    fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(value + '\n')
PY
```

각 파일은 UTF-8 한 줄이며 권한 0600 등으로 제한합니다. 마지막 LF/CRLF 한 개만 제거한 뒤 값을 그대로 보냅니다. 앞뒤 공백, `$`, 따옴표, 백틱, `~`, `!`, 백슬래시는 셸 확장 없이 전달합니다. **Enter나 개행을 값에 저장하지 않습니다.** Enter는 lineEnding 설정에 따라 서버가 추가합니다. 빈 파일·환경변수면 Enter만 보냅니다. 제어문자·여러 줄·1024바이트 초과 값은 거부합니다.

환경변수는 systemd의 비공개 EnvironmentFile 등으로 공급합니다. 모든 단계의 비밀을 접속 전에 검사하며 하나라도 없거나 안전하지 않으면 SSH 연결과 입력 전송을 시작하지 않습니다. 파일·환경변수 값은 새 세션마다 다시 읽습니다. 서비스 재시작 없이 파일 내용을 변경하면 다음 새 세션부터 사용합니다.

## AI에서 사용

MCP 주소와 도구 인자는 기존과 같습니다.

```json
{"tool":"open_session","arguments":{"targetId":"gated-dev","workspaceId":"app","clientRequestId":"unique-open-request"}}
```

성공하면 반환된 sessionId로 run_command, read_file, apply_patch 등을 사용합니다. 로그인 입력을 send_input으로 보낼 필요는 없습니다. send_input은 세션을 연 다음 실행한 프로그램의 일반 stdin 용도입니다.

동일 요청 ID의 재조회는 같은 세션 기록을 반환하며 로그인 입력을 반복하지 않습니다. reopen_session은 새 연결이므로 추가 로그인도 다시 진행합니다. 실패한 세션에 무작정 새 요청을 반복하지 않습니다.

## 실패 처리와 정보 보관

| 코드 | 의미 |
| --- | --- |
| `LOGIN_SECRET_UNAVAILABLE` | 비밀 누락 또는 파일 권한·소유자·종류·읽기 문제 |
| `LOGIN_SECRET_INVALID` | 입력 길이·개행·제어문자 문제 |
| `LOGIN_TIMEOUT` | 단계별 안내 또는 셸 준비 미확인. 문구·Enter 형식·지연 확인 |
| `GATEWAY_DISCONNECTED` | 게이트가 거절하거나 채널이 종료됨. 원인은 B에서 확인 |
| `GATEWAY_PROTOCOL_FAILED` / `GATEWAY_TIMEOUT` | 로그인 이후 개발용 제어 채널 실패 |
| `HOST_KEY_UNTRUSTED` / `AUTH_REQUIRED` | 추가 로그인 이전의 SSH 신뢰·인증 문제 |

오류에는 단계 번호·단계 이름만 포함하며 입력값과 화면 원문은 포함하지 않습니다. 로그인 입력을 자동 재시도하거나 일반 실행 채널로 우회하지 않습니다. 잘못된 안내 문구·입력·시간 초과에서는 연결을 닫고 실패로 반환합니다.

값과 로그인 화면은 B 메모리에서 일시 처리하고 MCP 결과·SQLite·감사 기록에 넣지 않습니다. 원격 게이트가 값을 echo해도 MCP 출력으로 반환하지 않습니다. 원격 장비 자체의 감사·터미널 기록이나 OS 메모리까지 제어하는 기능은 아닙니다. 일반 개발 명령이 별도로 비밀을 출력하면 기존 stdout/stderr 보관 정책이 적용됩니다.

## 실행 방식과 지원 한계

추가 로그인 대상은 로그인용 PTY 채널 하나를 열고 그 **동일 채널**을 계속 사용합니다. 로그인 완료 후 raw/no-echo로 전환하고 일시적인 Python 제어 프로세스를 시작해 파일 도우미와 비 PTY Bash worker를 관리합니다. 별도 실행 채널을 열어 게이트를 우회하지 않습니다. 개발 명령 자체는 기존처럼 PTY 없이 실행됩니다.

최종 셸에서 Linux, Bash, Python >=3.9, stty, /proc, workspace 쓰기와 실행이 가능해야 합니다. 관리 명령을 실행할 수 없는 메뉴 전용 장비, Windows 셸, 화면 앱, 동적 OTP, CAPTCHA, 달라지는 대화 분기는 지원하지 않습니다. 일반 PTY 개발 명령·터미널 크기 변경도 지원하지 않습니다.

제어 채널 단절 시 명령은 unknown으로 처리할 수 있고 자동 재실행하지 않습니다. 종료 시 worker 그룹을 정리하며, gateway가 비정상 종료하면 PID/시작 시각을 검사하는 watchdog도 worker 그룹을 종료합니다. 사용자가 별도 session/process group으로 분리한 프로그램까지 회수하는 기능은 아닙니다.

연결 옵션은 [OpenSSH PTY·escape 설정](https://man.openbsd.org/ssh)을 사용합니다. 상주 원격 서비스나 새 수신 포트를 추가하지 않습니다.

## 검증

`npm run check`는 기존 회귀 시험과 새 로그인 시험을, `npm run smoke`는 컴파일된 HTTP MCP 기동·인증된 도구 호출을 확인합니다. 가짜 자격정보를 사용하는 실제 격리 sshd의 ForceCommand로 게이트를 재현합니다. 문구 분할 수신, 순차 입력, echo 비공개, 준비 확인, 파일 패치, stdin, 긴 메시지, 취소·재접속, 연결 손실, 제한, 일반 SSH와 동시 사용을 점검합니다. 실제 사용자 게이트·Copilot·공개 HTTPS·IdP 검증은 별개입니다. [v0.3 검증 결과](V03_STATUS.md)를 확인하세요.
