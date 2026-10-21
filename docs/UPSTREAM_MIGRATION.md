# 업스트림 기능 조사와 마이그레이션 절차

이 문서는 Shell MCP를 여러 SSH 대상의 원격 개발에 맞게 지속 발전시키기 위한 반복 작업 기준입니다. 기능을 많이 복사하는 것이 목표가 아닙니다. 웹사이트에서 최신 근거를 조사하고, 현재 배치·인증·세션 모델에 맞는 기능만 골라 구현과 검증 결과를 남깁니다. AI API는 추가하지 않으며, 연결된 Copilot/Codex가 모델 역할을 제공합니다.

## 반복 절차

각 개선 라운드는 다음 순서로 진행합니다.

1. **웹 조사:** 원본 저장소의 기본 브랜치 커밋을 기록하고 README, 릴리스/변경 기록, 보안 문서, 실제 관련 소스를 확인합니다. `main`/`master` URL만 고정 근거로 쓰지 않습니다. 유행하는 기능 소개보다 동작 경로와 실패 처리를 우선합니다.
2. **적합성 판단:** 기능이 해결하는 사용자 문제, Shell MCP의 B→C OpenSSH 구조와의 적합성, 권한·비밀·실행 영향, 클라이언트 호환성, 유지비용, 라이선스를 기록합니다. 문자열 분류기 같은 우회 가능한 방어는 보안 경계로 취급하지 않습니다.
3. **작은 단위로 설계:** 상태 전이, 재시도/응답 유실, 여러 대상의 소유권, 셸 생명주기, 감사 추적을 정의합니다. 기존 동작과 설정의 호환성 및 마이그레이션 경로를 지정합니다.
4. **이식·구현:** 개념만 참고했는지, 코드를 실제로 가져왔는지 구분합니다. 가져온 코드에는 파일·커밋·라이선스·변경 내역을 `THIRD_PARTY_NOTICES.md`에 추가합니다. 테스트 fixture는 격리된 OpenSSH/임시 디렉터리를 사용합니다.
5. **검증·보고:** `npm run check`와 `npm run smoke`를 수행하고, 실제 VS Code/Copilot, 외부 IdP, 공개 HTTPS, 긴 soak가 실행되지 않았다면 별도로 NOT RUN이라 기록합니다. 빌드·로컬 시험을 운영 수용으로 표현하지 않습니다.
6. **다음 라운드 갱신:** 이 표의 상태·우선순위·출처 리비전을 갱신합니다. 차기 후보가 새 웹 조사에서 부적합해지면 사유를 남기고 재정렬합니다.

## 채택 기준

기능은 아래 기준을 만족할수록 우선합니다.

- 현재의 원격 개발 루프에서 분명한 반복 문제를 해결합니다.
- 서버가 권한과 상태를 검사할 수 있으며 실패를 성공처럼 표시하지 않습니다.
- 명령·입력·로그인 게이트 비밀을 MCP 요청/감사 기록에 노출하지 않습니다.
- 응답 유실 뒤 재호출해도 중복 실행 위험이 증가하지 않습니다.
- 사용자에게 위험 승인을 요구한다면 실제 MCP 클라이언트가 지원하는 승인 경로를 사용하고, 이를 보안 격리라고 과장하지 않습니다.
- 필요한 테스트와 운영 설명을 함께 제공할 수 있습니다.

## 기능 백로그

| 순위 / 상태 | 기능 | 조사 근거와 현재 판단 | 다음 작업 / 완료 증거 |
| --- | --- | --- | --- |
| P0 / v0.5 구현 | JSONL 감사 해시 체인과 검증기 | `tufantunc/ssh-mcp`의 감사·선택형 체인 아이디어를 검토. Shell MCP는 기존 로그 체크포인트, 전체 체인 검증, 단일 작성 잠금, 본문 비저장, 검증 CLI를 별도 구현 | 단위 시험, 기동 시 검증, CLI 검증을 확인. 구간 회전은 v0.6에서 추가 |
| P1 / v0.6 구현 | 체인 연속성을 보존하는 감사 회전 | 원본은 100 MiB 활성 파일과 10개 번호 파일을 회전하지만 검토한 store는 활성 파일의 마지막 해시를 읽고 전체 보관 구간을 검증하는 흐름은 찾지 못함 | Shell MCP는 세그먼트 파일명에 순번 범위/head를 넣고 시작·끝 이벤트를 체인에 포함. staging 복구·hard-link 구간 보존·전체 보관 구간 검증을 구현. 구간 삭제/체인 불일치/재시작 시험으로 검증. 자동 보존기간 삭제는 하지 않아 전체 디스크 관리는 남음 |
| P2 / v0.7 구현 | 제한된 원격 파일 목록과 메타데이터 | `tufantunc/ssh-mcp`의 bounded `sftp-list`는 디렉터리 항목/응답 바이트 제한을 설명함. OpenSSH `sftp ls -l`도 상세 파일 정보를 노출. Shell MCP는 workspace 제한이 있으므로 직접 SFTP 경로 모델보다 기존 helper와 `lstat` 경계를 사용 | 최대 10,000개 항목/8 MiB 이름 데이터, 100개 페이지, 일반 파일 크기·수정 시각·권한 표시. symlink 대상 추적 금지. 대형 목록에 `incomplete`와 제한 사유 표시. 실제 SSH 시험 통과 |
| P3 / 조사 필요 | 선택형 명령 승인 정책 | VS Code는 `readOnlyHint`가 아닌 도구의 확인 UI와 Elicitation을 설명함. `tufantunc/ssh-mcp`에는 승인 정책이 있지만 SECURITY/changelog에 명령 분류기 우회가 반복 공개됨 | 기본 도구 확인과 서버 측 `ask-all`을 구분. 적용한다면 classifier 없이 매 명령을 fail-closed로 승인하고 실제 Copilot에서 native dialog 중복·무응답 동작을 검증 |
| P4 / 조사 필요 | 스트리밍 SFTP/아티팩트 이동 | 큰 파일을 AI 문맥으로 통과시키지 않는 업스트림 도구는 유용하지만, B의 로컬 경로는 VS Code A의 workspace 파일을 뜻하지 않음 | B의 전용 private transferRoot와 A/B/C 파일 소유권을 먼저 설계. 경로 상한·체크섬·부분 전송·덮어쓰기·symlink·실패 복구와 감사 모델을 정하고 격리 SSH 시험 추가 |
| P5 / 조사 필요 | PTY 기반 대화형 프로그램 | 현재 명령은 재현성 있는 non-PTY Bash를 기본으로 함. TUI/REPL 사용 요청이 확인되면 추가 이점이 있음 | PTY를 기존 managed shell과 분리된 세션 모드로 평가하고 terminal resize, ANSI 출력, interrupt, 게이트 입력, 세션 유실 시험을 설계 |
| 보류 | 업스트림의 직접 SSH credential/profile, 임의 HTTP 상태 화면, 명령 문자열 위험 분류 | 본 프로젝트는 설치 PC의 OpenSSH config·키·agent, 기존 소유권 보호, 인증된 읽기 전용 브라우저 뷰가 요구됨. 원본 SECURITY 문서에는 classifier bypass 관련 공개 권고가 여러 개 있음 | 요구사항이 바뀌지 않는 한 현재 모델을 대체하지 않음 |

## 2026-10-22 현재 조사 입력

- [tufantunc/ssh-mcp 기준 리비전](https://github.com/tufantunc/ssh-mcp/tree/5c5b8476492cda568fca779b307ff8a2ca0bbbb7): `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`.
- [README와 기능 개요](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/README.md), [보안 한계](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/SECURITY.md), [감사 저장소](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/audit/store.ts), [세션 초기화](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/ssh/session-manager.ts), [HTTP transport](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/transport/http.ts).
- 해당 감사 저장소는 활성 로그 100 MiB, 최대 10개 번호 보관 파일을 기준으로 회전합니다. `loadLastHash`는 활성 로그 파일의 끝 최대 8192바이트에서 마지막 selfHash를 읽습니다. 읽은 범위에서는 전체 번호 보관 파일을 잇달아 검증하는 경로를 확인하지 못했습니다. Shell MCP는 보관 파일을 삭제하지 않고 전체 구간을 연결·검사하는 방향으로 적응했습니다.
- [현재 VS Code MCP 안내](https://code.visualstudio.com/api/extension-guides/ai/mcp)는 Elicitation과 `readOnlyHint`가 아닌 도구의 실행 확인을 설명합니다. 이는 사용자 PC의 실제 Copilot harness에서 서버 측 승인 요청이 동작한다는 증거가 아니며, 해당 연결은 아직 NOT RUN입니다.
- [VS Code MCP 서버 설정](https://code.visualstudio.com/docs/agent-customization/mcp-servers)과 [MCP Elicitation API](https://code.visualstudio.com/api/extension-guides/ai/mcp). 이 문서가 기능을 설명한다는 사실은 현재 PC의 Copilot 버전·정책이 승인 UI를 실제 표시한다는 수용 증거가 아닙니다.
- 상세 관찰·채택 판단은 [UPSTREAM_REVIEW](UPSTREAM_REVIEW.md)에 있습니다. 조사 당시 원본을 실행하지 않았으므로 원본 코드의 동작 검증으로 간주하지 않습니다.

## 2026-10-22 v0.7 라운드

- `tufantunc/ssh-mcp` main은 `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`로 재확인했습니다. 해당 리비전 [README](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/README.md)는 `sftp-list`의 항목/응답 바이트 제한과 모델 문맥을 거치지 않는 스트리밍 전송을 설명합니다. 실제 전송 루트는 이 저장소의 A/B/C 역할과 달라 별도 설계가 필요합니다.
- [OpenBSD sftp(1)](https://man.openbsd.org/sftp.1)은 기본 원격 목록의 정렬과 `-l` 상세 목록을 설명합니다. [OpenBSD stat(2)](https://man.openbsd.org/stat.2)의 `lstat` 의미에 맞춰 심볼릭 링크 대상이 아니라 링크 자체를 검사합니다.
- VS Code의 [MCP 개발 안내](https://code.visualstudio.com/api/extension-guides/ai/mcp)는 `readOnlyHint`가 아닌 도구의 확인 UI와 Elicitation을 문서화합니다. 실제 사용자 Copilot harness의 수용 시험은 아니므로 서버 측 승인 기능은 이번에 추가하지 않았습니다.
- 업스트림 소스는 복사하지 않았습니다. 개념만 기존 workspace 상대경로·SSH helper·고정 100-entry page에 맞게 새로 구현했습니다.

기능 백로그는 순위가 낮아도 새 웹 조사와 사용자 요구에 따라 다시 평가합니다. 다음은 A/B/C 경로가 서로 다른 SFTP streaming 요구를 조사합니다. 사용자 PC A의 로컬 파일 경로를 B에서 읽는 것처럼 다루지 않습니다.
