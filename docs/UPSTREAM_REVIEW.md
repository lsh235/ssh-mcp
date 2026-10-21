# 오픈소스 조사 근거

## 2026-10-22 v0.7: bounded 파일 목록 재조사

`tufantunc/ssh-mcp` main `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`의 [README](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/README.md)와 [CHANGELOG](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/CHANGELOG.md)를 웹에서 다시 확인했습니다. README는 제한된 `sftp-list`와 모델 context를 거치지 않는 file streaming을 설명합니다. 이 프로젝트는 현재 B의 로컬 transfer path가 A의 사용자 workspace를 가리키지 않으므로 streaming 전송을 보류하고, workspace 내부 bounded listing만 채택했습니다. OpenBSD `sftp ls -l`의 상세 목록을 참고해 metadata를 추가하되 [stat(2)](https://man.openbsd.org/stat.2)의 `lstat` 의미대로 symlink 자체만 봅니다.

같은 upstream CHANGELOG는 2.20.0에서 command classifier가 `make`, `ssh host cmd`, privilege broker 등 실행 전달 경로를 놓쳤던 문제와 수정을 기록합니다. 이를 포함한 반복 수정 이력 때문에 문자열 분류기를 권한 경계로 포팅하지 않습니다. VS Code의 [MCP tool confirmation 문서](https://code.visualstudio.com/api/extension-guides/ai/mcp)는 쓰기 도구 확인 UI를 설명하지만, 실제 사용자 Copilot에서 확인하지 않았으므로 별도 elicitation 승인 기능도 아직 추가하지 않았습니다.

Shell MCP v0.7은 upstream 코드를 복사하지 않았으며, Python SSH helper에 10,000 항목/8 MiB 수집 상한, cursor page, `incomplete` 사유, `lstat` 기반 metadata를 독립 구현했습니다. 자세한 시험 경계는 [V07_STATUS](V07_STATUS.md)에 기록했습니다.

## 2026-10-22 추가 조사: tufantunc/ssh-mcp

이번 라운드에서 [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp)의 기본 브랜치와 웹 문서를 확인했습니다. 기준 리비전은 `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`입니다. README, SECURITY, 세션 관리자, SSH 연결 어댑터, HTTP transport와 감사 저장소를 살펴봤습니다. 원본을 이 저장소에 설치하거나 실행하지 않았고, 특정 구현 파일을 복사하지 않았습니다.

| 검토 기능 | 프로젝트에 맞는 점 | 적용 판단 |
| --- | --- | --- |
| 세션별 SSH 프로필·대화형/background 명령 | 여러 SSH 대상·세션 사용이라는 목표와 맞음 | 세션 소유권·지속 Bash·OpenSSH 설정을 이미 갖춘 현재 모델을 유지하고, 실행 모드 변경은 별도 요구가 있을 때 검토 |
| 위험 명령 분류와 승인 | 명령 실행 전에 사용자 판단을 받는 선택지는 유용함 | 문자열 기반 파괴성 분류는 우회가 가능하다는 원본 보안 경고를 반영해 그대로 이식하지 않음. 향후 VS Code MCP elicitation 지원과 명시적 정책 경계를 함께 검토 |
| JSONL 감사·비밀 마스킹·회전·선택형 해시 연결 | 원격 개발의 실행 이력을 남기고 조작 여부를 점검하는 요구와 맞음 | v0.5에서 해시 체인을 도입하고 v0.6에서 무제한 보관 구간·구간별 체인 연결·기동 시 전체 검증·회전 복구를 독립 구현 |
| 직접 SSH 라이브러리와 프로필 자격정보 | 한 서버가 여러 접속정보를 직접 가질 때 유용할 수 있음 | 본 프로젝트는 설치 PC의 OpenSSH config·agent·키를 활용하고 신뢰된 host-key 검사를 유지해야 하므로 ssh2 자격정보 모델을 교체하지 않음 |
| SFTP 파일 전송 | 원격 개발 워크플로의 배포/아티팩트 이동에 도움이 될 수 있음 | 원격 파일 편집 도구와 같은 경로·권한 경계를 설계하고 파일 크기·부분 전송·감사 규칙을 검토한 뒤 별도 기능으로 평가 |

원본의 README는 역할·호스트 그룹 정책과 제한을 설명하고, [SECURITY 문서](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/SECURITY.md)는 위험 명령 분류가 일반적인 쓰기, alias/function/PATH 상태를 완전하게 판별하지 못할 수 있다고 경고합니다. 세션 관리자는 로그인 후 셸 초기화 명령을 넣지만, 현재 postLogin의 예상 프롬프트 기반 추가 로그인 절차를 대체하지 않습니다. HTTP 엔드포인트도 기존 인증된 MCP·브라우저 화면 설계를 대체하지 않아 선택적으로만 참고했습니다.

회전 소스는 활성 파일 100 MiB, 번호 보관본 최대 10개를 사용합니다. hash를 켠 경우 `loadLastHash`는 활성 파일의 끝부분에서만 마지막 해시를 읽습니다. 검토한 파일에서는 보관본 전체의 체인 연결을 기동 시 검증하는 로직을 찾지 못했습니다. Shell MCP는 오래된 구간을 자동 삭제하지 않고 보관 구간 전부를 부팅·CLI 검증에 포함합니다. 이는 원본 기능 복사가 아니라 보존·검증 범위를 확장한 적응입니다.

실제 화면·Copilot 클라이언트 연결, 외부 SSH 대상, TLS 배포는 이 조사에서 검증하지 않았습니다. 차기 후보와 반복 적용 절차는 [업스트림 마이그레이션 계획](UPSTREAM_MIGRATION.md), v0.5 구현 근거는 [검증 기록](V05_STATUS.md)을 참조하세요.

> 설계 단계의 조사 기록입니다. 이후 구현에서 이식한 범위는 [원본 고지](../THIRD_PARTY_NOTICES.md), 현재 구현 결과는 [구현 상태](IMPLEMENTATION_STATUS.md)를 참조하세요. 원본 두 프로젝트 자체를 빌드·실행한 것은 아닙니다.

조사일: 2026-10-21. GitHub 연결 도구로 기본 브랜치·커밋·파일을 읽고, 웹으로 VS Code·MCP·OpenSSH 공식 문서를 확인했습니다. 로컬 workspace는 시작 시 비어 있었습니다. 코드 그래프 도구는 이 세션에 제공되지 않아 그래프 generation·coverage 확인은 NOT RUN이며, 아래의 직접 소스 확인 범위로 근거를 제한합니다.

## 기준 리비전

| 저장소 | 기본 브랜치 | 확인 커밋 | 커밋 시각 UTC |
| --- | --- | --- | --- |
| Eugeny/tabby | master | `467ce8ebfa467fb88cf6d154c9a5891e3d3647f0` | 2026-10-06 21:17:08 |
| thuanpham582002/tabby-mcp-server | main | `5c08e2751dffd3b6fe3180f0c80fe5a7fde287df` | 2026-10-08 10:32:06 |

GitHub의 저장소 갱신 시각과 커밋 시각은 다릅니다. 위 값은 조사에서 확인한 커밋 식별자이며 최신 릴리스 번호를 의미하지 않습니다. 초기 주요 파일은 기본 브랜치에서 읽었고, 이후 확인한 브랜치 커밋이 위 리비전입니다. 구현 시에는 위 커밋으로 입력을 고정하고 다시 검사해야 합니다.

## Tabby에서 확인한 범위

- [`tabby-ssh/package.json`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/package.json): Angular와 Tabby 패키지에 대한 peer dependency를 확인했습니다.
- [`session/ssh.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/ssh.ts): 처음 220줄에서 russh import, SSHSession, 인증 방식·agent·DI 관련 타입과 초기화 일부를 확인했습니다. 파일 전체 감사를 하지 않았습니다.
- [`session/shell.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/shell.ts): 별도 셸 클래스, SSH 참조, 출력 구독 후 초기 cwd 적용, EOF/close 처리를 확인했습니다.
- [`session/shellChannel.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/shellChannel.ts): 터미널 타입 기본값과 PTY 요청 분리를 확인했습니다.
- [`services/sshMultiplexer.service.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/services/sshMultiplexer.service.ts): 프로필 기준 연결 보관과 종료 시 제거를 확인했습니다. 그 키를 새 서버의 사용자 격리 기준으로 그대로 사용하지 않습니다.
- [`session/authMethodSelection.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/authMethodSelection.ts): 순수 인증 계획 선택 로직을 확인했습니다. OpenSSH 기반 첫 버전에서는 직접 인증 구현에 필요하지 않아 이식 대상에서 보류합니다.

**도출한 설계 판단:** 연결과 셸의 수명을 분리하되, B의 OpenSSH 동작 재사용을 우선해 UI·DI·russh 코어 전체 포팅은 하지 않습니다. 이것은 새 프로젝트의 선택이며 원본이 OpenSSH CLI로 동작한다는 주장이 아닙니다.

## tabby-mcp-server에서 확인한 범위

- [`README.md`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/README.md): 실행 중인 Tabby 플러그인, 도구 목록, SSE 엔드포인트와 기본 loopback 설정을 확인했습니다.
- [`package.json`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/package.json): 패키지 버전 1.1.0, MCP SDK 1.8.0과 Tabby/Angular peer dependency를 확인했습니다.
- [`services/mcpService.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/services/mcpService.ts): SSEServerTransport, `/sse`, `/messages`, 별도 HTTP 도구 경로와 loopback 기본값을 확인했습니다. 확인한 서비스 파일에서는 인증 미들웨어를 확인하지 못했으며, 전체 제품에 인증이 전혀 없다는 exhaustive claim은 하지 않습니다.
- [`terminal/exec-command-tool.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/tools/terminal/exec-command-tool.ts): 처음 330줄에서 Tabby 탭 입력, 현재 명령 추적, 시작 전 Ctrl+C, 서브셸 래핑, 버퍼 polling, 표식 기반 종료 판별과 자동 재시도 경로를 확인했습니다. 이 구현으로 지속되는 cd/export를 보장할 수 없습니다.
- [`tools/shell-strategy.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/tools/shell-strategy.ts): 셸별 보조 전략이 존재함을 확인했습니다. 확인한 exec 도구와 실제로 연결되는 전체 call graph를 검증한 것은 아닙니다.
- [`services/commandOutputStorage.service.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/services/commandOutputStorage.service.ts): 결과 ID·메타데이터·메모리 Map·페이지 조회 구조를 확인했습니다.
- [`terminal/get-command-output-tool.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/tools/terminal/get-command-output-tool.ts): outputId 기반 조회 도구를 확인했습니다.

**도출한 설계 판단:** 명령 결과 모델과 페이지 조회 구조를 활용하고, 실행·저장·인증·네트워크 전송은 원격 서버의 요구사항에 맞게 다시 만듭니다. 기존 서버를 단순히 0.0.0.0에 바인딩하는 것만으로 요구사항이 충족된다고 판단하지 않습니다.

## 이식 계획과 원본 고지

| 출처 | 활용 계획 | 첫 버전 범위 |
| --- | --- | --- |
| Tabby SSHSession / SSHShellSession | 연결과 셸의 객체·생명주기 구조 참고 | 설계 재사용 |
| Tabby shellChannel | 터미널 타입 순수 로직과 관련 타입의 선별 이식 | PTY 확장 시 이식 |
| Tabby SSHProfile 관련 필드 | 별칭·사용자·포트·cwd의 프로젝트 타입으로 적응 | 프로필 모델 설계 |
| tabby-mcp output store / output tool | 결과 레코드·페이지 조회의 타입과 순수 로직 적응 | 구현 시 이식 후보 |
| tabby-mcp exec tool | 도구 계약 참고, 실제 실행 알고리즘 교체 | 설계 재사용 |

원본을 활용한다는 이유로 불필요한 Electron·Angular 런타임을 함께 넣지 않습니다. 실제 코드 복사 시에는 출처 파일·리비전·적응 내역을 `THIRD_PARTY_NOTICES`에 기록하고 관련 고지를 보존합니다. 아직 해당 이식이나 의존성 설치를 수행하지 않았습니다.

## 공식 문서와 설계에 반영한 사항

- [VS Code MCP 서버 추가](https://code.visualstudio.com/docs/agent-customization/mcp-servers): URL 서버 연결과 실제 도구 호출을 통한 검증.
- [VS Code MCP 설정 레퍼런스](https://code.visualstudio.com/docs/agents/reference/mcp-configuration): portable `mcpServers`와 VS Code `servers` 형식 차이, 입력 변수 제약.
- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http): 프로토콜 세션 제거, 요청별 스트림과 취소. 제품의 SSH sessionId를 독립적으로 설계.
- [MCP 2025-11-25 전송](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): 실제 클라이언트 버전에 따른 이전 동작 지원은 별도 어댑터로 처리.
- [MCP HTTP 인증](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): 원격 HTTP 인증을 SSH 인증과 별도 설계.
- [OpenSSH ssh_config](https://man.openbsd.org/ssh_config), [ssh](https://man.openbsd.org/ssh), [sftp](https://man.openbsd.org/sftp): 기존 설정 활용, 전용 master 소켓, 키/agent, 엄격한 host key, 보조 파일 채널.

## 검증 한계

두 저장소를 빌드하거나 실행하지 않았습니다. 실제 SSH 접속, 네트워크 캡처, 터미널 상태 보존, Copilot 연결, OAuth 상호운용, 파일 충돌, 취소 동작은 확인하지 않았습니다. 이번 산출물은 조사 근거에 기반한 구현 설계이며 제품 수용 테스트 결과가 아닙니다.
