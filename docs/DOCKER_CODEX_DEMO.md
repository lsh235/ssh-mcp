# Docker + 현재 Codex 세션 MCP 시험

시험일: 2026-10-21. **결과: PASS — 현재 Codex 대화가 실제 MCP 호출 결과를 읽고 수정·재시험을 수행했습니다.**

## 구성

```text
현재 Codex 대화의 AI
       │ 실행 도구로 MCP SDK 클라이언트 호출
       ▼
호스트 Shell MCP · HTTP 127.0.0.1:37135/mcp
       │ 호스트의 전용 SSH 키 / 지속 Bash
       ▼
Docker 컨테이너 1개 · shell-mcp-demo-target
       └─ developer 계정 / /workspace/project / Python 코드와 테스트
```

Docker 컨테이너는 작업 대상 PC(C)를 대신합니다. MCP 서버(B)는 호스트에서 실행합니다. 컨테이너의 SSH 포트와 MCP 포트는 모두 호스트 loopback에 한정했습니다. 기존의 다른 컨테이너는 변경하지 않았습니다.

AI 판단은 이 대화의 Codex가 수행했습니다. 별도 LLM 프로세스·새 Codex 대화·OpenAI API 클라이언트·API 키를 생성하거나 호출하지 않았습니다. 로컬 Codex CLI의 인증 상태 조회는 `Logged in using ChatGPT`였습니다. 구독 인증과 API 키 인증의 차이는 [공식 인증 안내](https://learn.chatgpt.com/docs/auth)를 참조할 수 있습니다.

현재 대화의 고정 도구 목록에 새 MCP 서버를 직접 등록하는 도구가 없어 `scripts/mcp-call.mjs`를 프로토콜 어댑터로 사용했습니다. 이 파일은 MCP 도구 검색/호출과 결과 전달만 수행하며, 수정 알고리즘이나 LLM 호출을 포함하지 않습니다. **Codex 네이티브 MCP 도구 등록·핫리로드 시험은 NOT RUN**입니다. SDK 경유 실제 HTTP MCP 호출과 네이티브 도구 등록을 구분합니다. Codex의 일반 MCP 설정은 [공식 MCP 안내](https://learn.chatgpt.com/docs/extend/mcp)를 참고하세요.

## 직접 수행한 개발 루프

1. MCP `tools/list`로 도구 14개를 발견하고 `list_targets`, `open_session`을 호출했습니다.
2. `read_file`로 컨테이너의 `pricing.py`, `test_pricing.py`를 읽었습니다.
3. 같은 셸에서 환경변수와 Python venv를 준비한 뒤 `run_command`로 테스트했습니다. 5개 중 2개 실패, 종료 코드 1을 받았습니다.
4. `read_output`으로 `22.00 != 21.60`, `27.00 != 26.40`의 실패를 확인했습니다. 할인 전 금액으로 세금을 계산하는 원인을 이 대화의 Codex가 해석했습니다.
5. 읽은 파일 해시를 넣어 MCP `apply_patch`로 할인 적용 후 과세하도록 두 줄을 수정했습니다. 로컬 Docker 빌드 원본은 의도적인 실패 fixture로 보존했습니다.
6. 같은 sessionId에서 테스트를 다시 실행해 5개 모두 성공, 종료 코드 0을 받았습니다. 테스트 파일의 전후 해시가 같음을 확인했습니다.
7. 작업 디렉터리 `/workspace/project`, 환경변수 `subscription-session`, 가상환경 `/workspace/project/.venv`가 후속 호출에 유지됐습니다.
8. 별도 MCP 클라이언트가 매번 연결/종료하는 중에도 8초 명령은 계속 실행됐습니다. 같은 요청 키를 다시 보내 동일 commandId를 받았고, 부작용 파일은 `once` 한 번만 기록됐습니다.
9. `git_diff`와 최종 파일을 MCP로 읽어 변경을 확인했습니다. 컨테이너 내부의 코드 편집·시험은 MCP를 사용했고 `docker exec`로 우회하지 않았습니다.

## 증거

- [기계 판정 보고서](../test-results/docker-demo/report.json)
- [MCP 요청·응답 원문](../test-results/docker-demo/transcript.jsonl)
- [수정 전 테스트](../test-results/docker-demo/before-tests.txt), [수정 후 테스트](../test-results/docker-demo/after-tests.txt)
- [세션 유지 결과](../test-results/docker-demo/session-state.txt)
- [원격 변경 diff](../test-results/docker-demo/remote-change.patch), [최종 코드 사본](../test-results/docker-demo/pricing.fixed.py)

실행 후 `node scripts/verify-docker-demo.mjs`가 결과·전후 해시·세션 ID·중복 실행 여부·컨테이너 mount와 포트 경계를 함께 확인했습니다.

## 다시 사용하기

현재 컨테이너와 MCP 서버는 실행 상태로 남겼습니다. 수정된 코드는 컨테이너 안에 있고 fixture 원본은 재현을 위해 실패 상태로 보존합니다. SSH 셸은 서버의 기본 idle lease(30분)에 따라 만료될 수 있습니다.

```bash
node scripts/docker-demo.mjs status
node scripts/docker-demo.mjs stop
node scripts/docker-demo.mjs resume
```

새 환경에서 최초 생성은 다음과 같습니다. 이미 provision한 환경에서는 `start`가 자격증명과 컨테이너를 덮어쓰지 않으며 `resume`을 사용합니다.

```bash
npm ci
npm run build
node scripts/docker-demo.mjs start
node scripts/mcp-call.mjs <<'JSON'
{"tool":"list_targets"}
JSON
```

도구 호출 어댑터에 `{ "tool": "open_session", "arguments": { ... } }` 형태의 JSON을 stdin으로 보냅니다. `tools/list`는 `{ "method": "tools/list" }`를 사용합니다.

호스트 전용 키·토큰·서버 상태는 Git에서 제외된 `.state/docker-demo`에 저장합니다. `runtime.json`은 토큰을 포함하므로 출력하거나 공유하지 않습니다. 컨테이너에는 `target-keys`의 서버 host key와 클라이언트 **공개키**만 read-only로 공유합니다. 호스트 SSH 개인키, MCP 토큰, Codex 로그인 파일은 공유하지 않습니다.

컨테이너 이미지의 기준 Python 이미지는 빌드 시 `python:3.12-slim-bookworm@sha256:5d9e6adc9abd558bc0ce05f9ab16cef71328916fc9728f6b81e337af86a737e2`로 해석됐습니다. 실제 생성 이미지·컨테이너 ID는 보고서에 기록했습니다. 태그 재빌드는 동일 바이트 보장이 아닙니다.

## 판정 경계

- Docker 대상 + 현재 Codex 판단 + 실제 HTTP MCP + SSH 개발 루프: **PASS**.
- Codex 네이티브 MCP 도구 등록: **NOT RUN**.
- VS Code Copilot, 외부 OAuth, 공개 HTTPS, 별도 물리 PC 네트워크: **NOT RUN**.

이 시험은 의도적으로 실패 사례를 넣은 작은 Python 프로젝트의 검증이며, 운영 서비스 전체의 준비 완료를 의미하지 않습니다.
