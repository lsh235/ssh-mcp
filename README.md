# Shell MCP

VS Code의 Copilot이 원격 프로젝트를 읽고 수정하고, 같은 SSH 셸에서 명령과 테스트를 반복하도록 돕는 원격 MCP 서버입니다.

**현재 상태: v0.2 구현. MCP 도구 19개, 로컬 OpenSSH·HTTP MCP와 Docker 대상 검증. 실제 사용자 PC의 Copilot·외부 IdP·공개 HTTPS 배포는 미검증입니다.**

v0.2에는 실행 중 stdin 입력/EOF, 명령 완료 대기, 원격 코드 검색, 명령 이력, 종료된 세션의 새 세대 열기를 추가했습니다. [추가 기능 사용법](docs/V02_USAGE.md)과 [v0.2 검증 결과](docs/V02_STATUS.md)를 확인하세요.

## 시작

```bash
npm ci
npm run build
npm run smoke
# config.token.example.json을 config.local.json에 복사하고 대상·경로를 수정
# SHELL_MCP_TOKEN에 32바이트 이상의 토큰을 안전하게 제공
node dist/cli.js --config config.local.json
```

설치·인증·SSH agent·VS Code 설정은 [운영 안내](docs/OPERATIONS.md)를 따릅니다. 실행 가능한 예시는 `config.example.json`(원격 OAuth), `config.token.example.json`(개인 개발용 토큰), `examples/`, `deploy/`에 있습니다. 비밀을 설정 예시나 채팅에 저장하지 않습니다.

## 존재 이유와 목표

단발성 SSH 명령만 실행하면 작업 디렉터리, `export`, 가상환경 활성화 같은 셸 상태가 다음 요청에 이어지지 않습니다. 터미널 화면만 읽으면 긴 출력이 잘리거나 명령 완료를 잘못 판단할 수도 있습니다. Shell MCP는 서버가 SSH 연결과 지속되는 셸을 소유하고, 명령 상태·파일 변경·실행 결과를 Copilot에 명시적으로 돌려주는 것을 목표로 합니다.

사용자가 확정한 인증정보의 위치는 **원격 MCP가 설치된 PC**입니다. VS Code PC의 SSH 키를 원격으로 전달하는 구성이 아닙니다.

```text
A. 사용자 PC                  B. 원격 MCP 설치 PC                C. 작업 대상 PC
VS Code / Copilot ──HTTPS──▶ Shell MCP ──SSH 연결 + 지속 셸──▶ 프로젝트 / 빌드 / 테스트
                              │
                              └─ B의 SSH config · 키 · agent 사용
```

MCP를 설치하는 곳은 B입니다. C에는 기존 SSH 서버와 Bash·Python 3·setsid를 사용하며, 상주 MCP 서버나 추가 수신 포트를 요구하지 않습니다. 관리용 임시 셸 스크립트와 명령 로그는 C에 생성합니다. B와 C가 같은 PC인 구성은 추후 로컬 실행 어댑터로 지원할 수 있지만, 첫 버전의 중심은 B에서 C로 접속하는 SSH 구성입니다.

## 사용 흐름

1. Copilot이 서버에 등록된 작업 대상을 확인합니다.
2. B가 자신의 SSH 인증정보로 C에 연결하고 전용 셸을 만듭니다.
3. Copilot이 C의 파일을 읽고 수정 패치를 적용합니다.
4. 같은 셸에서 환경을 활성화하고 빌드·테스트를 실행합니다.
5. Copilot이 종료 코드와 출력으로 결과를 판단하고 수정·재실행을 반복합니다.

코드의 기준본은 C의 프로젝트입니다. 로컬 파일을 수정하는 방식에는 별도의 동기화가 필요하며, 기본 설계는 원격 파일 도구를 통한 직접 수정입니다.

## 문서

- [상세 설계](docs/DESIGN.md): 배치, 인증, 지속 셸, 도구 계약, 파일 편집, 장애 처리, 검증 기준
- [설치·운영 안내](docs/OPERATIONS.md): 실행 설정, OAuth/토큰, 사용자 서비스와 VS Code 예시
- [구현·검증 결과](docs/IMPLEMENTATION_STATUS.md): 구현 범위와 검증 한계
- [Docker + 현재 Codex 세션 시험](docs/DOCKER_CODEX_DEMO.md): 컨테이너 원격 코드 수정·재시험과 실제 MCP 호출 기록
- [v0.2 설계](docs/V02_DESIGN.md) · [사용법](docs/V02_USAGE.md) · [검증 결과](docs/V02_STATUS.md)
- [오픈소스 조사 근거](docs/UPSTREAM_REVIEW.md): 확인한 리비전, 재사용 범위와 교체할 부분
- [대화형 구조도](docs/architecture.html): 연결 구조와 서버별 책임
- [구조도 검증 기록](docs/DIAGRAM_QA.md): 문서 산출물 검증과 실제 제품 검증의 구분

구조도 설명은 한국어이며, 뷰어 고정 메뉴와 HTML 언어 설정은 영어로 표시됩니다.

## 두 오픈소스 활용 방향

| 원본 | 활용 대상 | 새 설계에서 변경하는 부분 |
| --- | --- | --- |
| [Tabby](https://github.com/Eugeny/tabby) | SSH 연결과 셸 분리, 연결 생명주기, 프로필 구조, 터미널 타입 정규화 | Electron·Angular 의존성을 분리하고 실제 접속은 B의 OpenSSH로 수행 |
| [tabby-mcp-server](https://github.com/thuanpham582002/tabby-mcp-server) | 명령 도구, 결과 ID, 출력 페이지 조회, 실행 이력의 구조 | 탭 조작·화면 버퍼 수집을 서버 소유 셸·명령 로그 수집으로 교체 |

Tabby 앱과 기존 플러그인은 필수 실행 의존성에 포함하지 않습니다. Tabby는 연결/셸 생명주기 설계에 활용했고, tabby-mcp-server의 출력 페이지 경계 계산을 바이트 단위 조회로 적응했습니다. 실제 이식 범위·변경점·원본 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 기록했습니다.

## 첫 버전의 성공 기준

- 실제 VS Code Copilot이 HTTPS MCP 도구를 호출하고 원격 결과를 이용합니다.
- B의 SSH 설정·키로 C에 접속합니다.
- 세 번의 별도 도구 호출 사이에 `cd`, 환경변수, 가상환경이 유지됩니다.
- 원격 파일 읽기 → 수정 → 실패 테스트 → 재수정 → 성공 테스트를 완료합니다.
- HTTP 연결이 끊겨도 명령을 중복 실행하지 않고 상태를 다시 조회합니다.
- SSH 연결 손실·시간 초과를 성공으로 보고하지 않습니다.
- 인증되지 않은 호출과 허가되지 않은 대상 접근을 차단합니다.

실제 loopback sshd와 HTTP MCP 클라이언트를 사용한 검증 범위는 [구현·검증 결과](docs/IMPLEMENTATION_STATUS.md)를 참조하세요. 실제 Copilot과 사용자 원격 환경의 수용 검증이 남아 있어 운영 출시 판정은 **NO-GO**입니다.
