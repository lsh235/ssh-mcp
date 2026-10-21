# VS Code Browser에서 현재 SSH 세션 확인과 파일 전송 (v0.9.0)

VS Code Desktop의 **Integrated Browser**에서 이번 대화에 연결한 SSH 세션·명령 상태·출력을 확인하고, 사용자가 고른 파일을 원격 작업 공간에 업로드하거나 원격 파일을 내려받을 수 있습니다. 추가 확장을 설치하지 않고 서버가 제공하는 웹 페이지를 엽니다. 일반 브라우저에서도 사용할 수 있습니다.

이 기능에서 “현재 대화”는 **AI가 현재 대화에서 사용 중인 sessionId를 명시적으로 묶은 보기**입니다. VS Code의 활성 채팅 ID나 대화 원문을 자동 수집하지 않습니다. 같은 인증 사용자에게 속한 세션만 묶을 수 있으며, 보기 링크만 아는 다른 사용자는 접근할 수 없습니다.

## 사용 순서

1. B 서버를 최신 코드로 빌드하고 재시작합니다. 진행 중 SSH 작업을 먼저 확인하며 재시작 후에는 새 세션이 필요합니다. `/mcp`와 함께 `/sessions`, `/session-assets/`, `/viewer-api/`도 기존 HTTPS 프록시를 통해 접근 가능해야 합니다. 제공한 Caddy 예시는 전체 경로를 전달합니다.
2. MCP 도구를 다시 발견합니다. v0.4는 **20개 도구**이며 `create_session_view`가 추가됐습니다.
3. AI에게 다음처럼 요청합니다.

```text
이번 대화에서 사용 중인 SSH 세션들만 create_session_view로 묶어줘.
보기 링크를 알려주고, 브라우저 도구가 있으면 VS Code Integrated Browser에서 열어줘.
MCP 접속 토큰은 브라우저 도구 인자나 채팅으로 전달하지 마.
```

AI가 호출할 도구 인자는 다음 형태입니다. sessionIds에는 실제 반환된 SSH 세션 ID를 사용합니다. clientRequestId는 새 보기마다 고유한 값으로 바꾸고 응답 유실 확인에만 재사용합니다.

```json
{
  "tool": "create_session_view",
  "arguments": {
    "sessionIds": ["SESSION_ID_BACKEND", "SESSION_ID_FRONTEND"],
    "label": "이번 대화 · 원격 개발",
    "clientRequestId": "unique-view-request"
  }
}
```

4. 반환된 `result.url`을 엽니다. 예: `https://mcp.example.com/sessions#v_...`. 주소에는 접속 토큰을 넣지 않습니다.
5. VS Code 명령 팔레트의 **Browser: Open Integrated Browser**에 URL을 입력할 수도 있습니다. VS Code 웹 버전이나 기능이 없는 버전은 일반 브라우저로 엽니다. 별도 Simple Browser iframe에 넣는 방식은 CSP 때문에 지원하지 않습니다.
6. 화면의 비밀번호 입력란에 B와 같은 접속 토큰을 **직접** 입력합니다. AI에게 토큰 입력을 맡기거나 채팅에 붙이지 않습니다. 토큰은 페이지 메모리에서만 사용하며 새로고침·페이지 이동·연결 해제 후 다시 입력합니다. OAuth 서버라면 유효한 JWT access token을 입력할 수 있으나 브라우저용 자동 OAuth 로그인은 제공하지 않습니다.

MCP 클라이언트에 설정한 인증 헤더가 브라우저에 자동 전달되지는 않습니다. 이 단계가 별도로 필요합니다. 공용 접속은 HTTPS를 사용하며 실제 publicUrl과 allowedHosts를 맞춥니다. 동일 사이트의 화면 자원·조회 요청은 허용하지만 기존 `/mcp`의 Origin 검사는 그대로 유지합니다.

## 확인할 수 있는 정보

- 이 보기에 포함한 여러 SSH 세션과 각각의 대상·workspace·cwd·세대·연결 상태
- 선택한 세션의 최근 명령 50개(최신순), 표시 이름·명령 ID·실행 상태·종료 코드
- 선택한 명령의 stdout/stderr, 현재까지 읽은 바이트, 출력 확정·잘림 여부
- 약 2초마다 상태와 출력 갱신, 수동 새로고침·출력 더 읽기
- 밝은/어두운 테마, 작은 화면 레이아웃

명령 실행·입력 전송·취소는 기존 MCP 도구에서 수행합니다. 파일 전송은 이 화면에서 사용자가 경로와 파일을 확인한 뒤 버튼을 눌러 시작합니다. 화면을 닫거나 연결을 해제해도 이미 시작된 SSH 작업은 취소되지 않습니다.

## 브라우저에서 파일 전송

전송 패널의 경로는 현재 선택한 session의 등록 workspace 기준 상대 경로이며, 셸의 현재 cwd와 관계없습니다. 업로드는 브라우저의 파일 선택 대화상자에서 사용자가 고른 파일만 전송합니다. B에서 A의 임의 경로를 읽거나 디렉터리 전체를 자동 전송하지 않습니다. `..`, 절대 경로, symlink 경로와 일반 파일이 아닌 원격 항목은 거부됩니다.

업로드는 C에서 새 파일을 원자적으로 생성하며, 같은 경로에 파일이 있으면 내용을 비교하거나 덮어쓰지 않고 실패합니다. 상위 디렉터리는 미리 만들어져 있어야 합니다. 부분 업로드는 최종 파일명으로 노출하지 않습니다. 브라우저는 파일·경로·세션 조합에서 만든 비밀이 아닌 fingerprint를 sessionStorage 키로 쓰고, 요청 ID만 저장합니다. 토큰은 저장하지 않습니다. 같은 탭을 새로고침하면 토큰을 다시 입력하고 같은 파일·경로를 재선택해 업로드를 재시도할 수 있습니다. 브라우저가 B로 보낸 청크는 B가 private staging 파일에 쓴 뒤 SHA-256을 확인하고 offset을 확정합니다. 응답이 유실되면 같은 요청 ID로 B의 확인 offset을 다시 받아 그 지점부터 이어 보내며, 화면은 전송 중 바이트와 서버가 확인한 바이트를 구분합니다. B는 확인한 파일을 기존 SSH 업로드 경로로 C에 전송하고, C도 prefix와 최종 SHA-256을 확인합니다. 따라서 네트워크 재시도 때 A→B와 B→C 모두 확정된 위치 뒤부터 이어질 수 있습니다. 업로드가 `limits.transferTimeoutMs` 이상 비활성 상태이면 다음 viewer 요청 때 staging이 만료 정리됩니다. MCP 서버가 재시작되면 요청 ID와 B staging이 사라져 A→B는 처음부터 시작합니다. SSH 세션이나 MCP 서버가 재시작된 뒤 B→C를 자동 재개하지 않습니다. 연결이 끊기고 결과가 불확실하면 먼저 원격 경로를 확인하세요. 비정상 종료로 남은 staging은 다음 서버 기동 때 정리합니다. C측 worker 임시 디렉터리는 새 SSH worker가 연결될 때 24시간 이상 지난 항목 중 PID와 시작 시각으로 종료를 확인한 것만 정리합니다. 대상에 재연결하지 않거나 신원·파일 구조가 불확실한 디렉터리는 남을 수 있습니다.

업로드 중 **업로드 취소**를 누르면 현재 최대 1 MiB 청크의 응답을 기다린 다음 B의 미완성 staging을 삭제합니다. 취소 응답이 불확실하면 같은 요청 ID를 보존하고 취소 재시도를 표시합니다. 상태가 `SSH 대상에 반영하는 중`으로 바뀌면 취소 버튼이 사라집니다. 이 단계에서 실행 중인 B→C SSH 작업을 브라우저 취소로 중단한다고 보장하지 않습니다.

다운로드는 C의 원본을 세션 전용 임시 디렉터리에 복사하고, 원본 변경 여부와 SHA-256을 확인한 뒤 브라우저로 스트리밍합니다. 전송 중 연결이 끊기면 임시 파일을 정리합니다. C에는 다운로드 크기만큼 추가 임시 공간이 필요합니다. 브라우저가 받은 파일은 사용자의 다운로드 위치에서 저장합니다.

기본 파일 크기 한도는 64 MiB입니다. B의 설정에서 `limits.maxTransferBytes`를 최대 256 MiB까지 조정하고, 전송 제한 시간은 `limits.transferTimeoutMs`로 설정할 수 있습니다(기본 5분, 최대 30분). 브라우저 업로드는 1 MiB 청크, 최대 256개 청크를 사용하며 여러 업로드의 B측 staging 합계와 동시 작업 수도 제한합니다. 파일 바이트는 MCP 인자·도구 응답·감사 이벤트에 넣지 않습니다. 완료·비재개 오류·비활성 만료 때 B의 임시 업로드를 지우고, 재개 가능한 네트워크 오류의 조각은 제한 시간까지 유지합니다. 만료 정리는 다음 viewer 요청 때 수행하며 비정상 종료 뒤 남은 파일은 다음 기동 때 정리합니다. 보통 SSH 포트만 사용하고 C에 HTTP listener나 SFTP subsystem을 추가하지 않습니다. 추가 로그인 화면이 있는 대상도 기존 인증된 SSH helper 경로를 사용합니다.

### 명령 표시 이름

명령 원문은 기존처럼 영구 보관하지 않습니다. 알아보기 쉬운 이름이 필요하면 `run_command`의 선택 인자 `displayName`에 **비밀 없는 짧은 명령 또는 설명**을 지정합니다. 이름은 최대 160자이며 저장되어 조회됩니다. 예전 명령이나 이름을 생략한 명령은 ID로 표시합니다. 자동으로 비밀을 지우는 필터가 아니므로 토큰·비밀번호를 이름에 넣지 않습니다.

```json
{
  "tool": "run_command",
  "arguments": {
    "sessionId": "SESSION_ID_BACKEND",
    "command": "npm test",
    "displayName": "npm test · 백엔드 테스트",
    "clientRequestId": "unique-test-request"
  }
}
```

표시 이름도 요청 내용의 일부입니다. 같은 요청 ID로 이름만 바꾸면 REQUEST_CONFLICT이며, 요청 ID를 새로 발급하면 실제 명령을 다시 실행할 수 있으므로 이름 변경 목적으로 재실행하지 않습니다.

## 대화와 SSH 세션의 관계

하나의 채팅에 여러 SSH 세션을 포함할 수 있습니다. 서버는 채팅 플랫폼의 세션 ID를 받지 않으므로 AI가 현재 대화의 세션만 선택해야 합니다. 보기 label은 설명용이며 권한·사용자 격리의 기준이 아닙니다. 같은 사용자가 소유한 다른 대화의 세션을 명시적으로 추가하면 함께 표시될 수 있습니다.

보기는 SQLite에 남으며 같은 요청 재조회는 같은 URL을 반환합니다. 저장 가능한 보기는 사용자당 최대 1000개입니다. 재시작 뒤에도 과거 보기를 조회할 수 있지만 끊어진 셸을 복구하지는 않습니다. reopen_session은 새 ID이므로 그 ID로 새 보기를 만들거나 기존 세션들과 다시 묶습니다. SSH 세션 상태와 마지막 cwd는 서버가 확인한 기록이며 연결이 끊기면 실제 원격 상태와 다를 수 있습니다.

## 출력과 접근 제어

각 조회와 파일 전송마다 기존 Bearer 인증, 소유자, 대상 접근 권한, 해당 보기에 세션이 포함되는지를 검사합니다. 보기 ID는 로그인 수단이 아닙니다. 브라우저 API는 세션·명령 조회 GET, 파일 다운로드 GET, 업로드 create/PATCH/complete, 미완료 host staging 삭제만 제공합니다. 원격 명령 실행과 명령 취소 API는 노출하지 않습니다.

화면의 조회 전용 동작이 기존 MCP 토큰 자체의 권한을 축소하는 것은 아닙니다. 인증에는 원래 권한을 가진 토큰을 사용하므로 신뢰한 서버의 페이지에서만 입력합니다.

로그인 화면·SSH 키·추가 로그인 비밀·명령 stdin은 화면 데이터에 포함하지 않습니다. 프로그램이 stdout/stderr에 비밀을 출력하면 이 화면에서도 보이므로 출력에 비밀을 남기지 않습니다. 출력과 이름은 HTML로 삽입하지 않고 텍스트로 표시합니다. CSP·no-store·no-referrer를 적용합니다. 쿠키나 localStorage는 사용하지 않고, sessionStorage에는 재시도용 요청 ID만 저장하며 토큰은 저장하지 않습니다.

출력은 스트림당 한 번에 최대 32 KiB씩 바이트 커서로 읽습니다. UTF-8이 페이지 경계에서 나뉘어도 base64 원본과 스트림 디코더로 이어 붙입니다. 화면 메모리가 커지지 않도록 각 스트림에서 최근 표시분만 유지합니다. 전체 기록이 필요하면 기존 MCP read_output의 커서 조회를 사용합니다. 서버 보관 기간이 지나면 출력을 사용할 수 없다고 표시합니다. 최근 50개 이전 명령은 MCP list_commands로 조회합니다.

VS Code의 Share with Agent로 이 페이지를 공유하면 화면의 출력도 AI 컨텍스트가 될 수 있습니다. 공유할 출력 범위를 확인하고 클라이언트의 공유·권한 설정을 따릅니다.

## VS Code 소스 조사 근거

2026-10-21에 `microsoft/vscode`의 리비전 **386203d9b1559d29e9bab2ce9a19800230d13cc6**을 고정해 다음 경로를 확인했습니다. 아래는 해당 범위의 조사 결과이며 전체 VS Code API를 완전히 감사한 결과는 아닙니다.

| 소스 | 확인한 동작 / 설계 반영 |
| --- | --- |
| [simple-browser extension](https://github.com/microsoft/vscode/blob/386203d9b1559d29e9bab2ce9a19800230d13cc6/extensions/simple-browser/src/extension.ts#L17) | 내장 확장이 workbench.action.browser.open으로 URL을 전달. 새 확장 없이 기본 명령으로 페이지를 열도록 함 |
| [native browser view](https://github.com/microsoft/vscode/blob/386203d9b1559d29e9bab2ce9a19800230d13cc6/src/vs/platform/browserView/electron-main/browserView.ts#L157) | Electron WebContentsView를 생성. 일반 웹 페이지를 대상으로 구현 |
| [web implementation](https://github.com/microsoft/vscode/blob/386203d9b1559d29e9bab2ce9a19800230d13cc6/src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts#L61) | 확인한 웹 구현에서 Integrated Browser 생성이 지원되지 않음. Desktop과 일반 브라우저 경로 구분 |
| [open browser tool](https://github.com/microsoft/vscode/blob/386203d9b1559d29e9bab2ce9a19800230d13cc6/src/vs/workbench/contrib/browserView/electron-browser/tools/openBrowserTool.ts#L122) | 내부 도구가 호출 컨텍스트의 채팅 세션을 사용. 그 내부 정보를 원격 MCP에 제공한다고 가정하지 않음 |
| [ChatContext API](https://github.com/microsoft/vscode/blob/386203d9b1559d29e9bab2ce9a19800230d13cc6/src/vscode-dts/vscode.d.ts#L19673) | 확인한 공개 ChatContext.history는 해당 participant 범위. 임의의 기존 채팅 전체를 읽는 설계로 확장하지 않음 |

[공식 Integrated Browser 안내](https://code.visualstudio.com/docs/debugtest/integrated-browser)도 확인했습니다. VS Code 소스는 참고만 했으며 제품 코드를 복사하거나 VS Code를 포크하지 않았습니다. 외부 확장이나 비공개 채팅 DB 접근도 사용하지 않습니다.

## 검증과 한계

`npm run check`는 브라우저 API의 바이너리 업로드·다운로드, 2 MiB를 넘는 청크 전송, 체크섬, 확인 offset 재조회, 오래된 offset 거부, 동일 요청 ID 재조회, 다른 내용 충돌, 기존 파일 덮어쓰기 거부, 보기 밖 세션 거부, symlink 거부와 기존 SSH·추가 로그인 회귀 시험을 확인합니다. v0.9.0의 검증 세부는 [상태 기록](V09_STATUS.md)에 있습니다. 실제 VS Code Desktop Integrated Browser와 사용자 HTTPS 배포는 별도 수용 시험이며, 로컬 브라우저 시험만으로 통과를 주장하지 않습니다.

이 실행 환경에는 VS Code Desktop이 없어 그 본체에서 Integrated Browser를 여는 수용 시험은 NOT RUN입니다. 실제 사용자 PC의 브라우저 도구·외부 HTTPS·OAuth도 별도 확인이 필요합니다. [v0.4 검증 기록](V04_STATUS.md)을 참조하세요.
