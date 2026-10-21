# 오픈소스 조사 근거

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
