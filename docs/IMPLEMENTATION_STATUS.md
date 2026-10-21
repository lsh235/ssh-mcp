# v0.1 구현 및 검증 결과

> v0.1 시점의 기록입니다. 현재 v0.2의 추가 기능과 검증은 [V02_STATUS.md](V02_STATUS.md)를 참조하세요.

작성일: 2026-10-21, Asia/Seoul.

**로컬 구현·실행 검증: PASS. 사용자 환경 수용·운영 출시: NO-GO.** 실제 VS Code Copilot, 외부 IdP, 공개 HTTPS와 사용자 지정 SSH 대상에서의 검증이 남아 있습니다.

후속 시험에서 [Docker + 현재 Codex 대화의 MCP 개발 루프](DOCKER_CODEX_DEMO.md)를 통과했습니다. 현재 대화가 MCP SDK 어댑터로 도구를 호출해 컨테이너 안의 테스트 실패 2건을 수정하고 5건 전체 성공을 확인했습니다. 네이티브 Codex MCP 등록과 실제 Copilot 검증은 별도 미실행 항목입니다.

## 구현한 것

- TypeScript 서버와 14개 MCP 도구. 공식 SDK 2.3.1의 Streamable HTTP와 이전 2025 리비전 stateless 호환 경로.
- 인증: 개발용 bearer token과 원격 OAuth 리소스 서버. JWT 서명·issuer·audience·만료·허용 주체·scope 검사, protected-resource metadata 제공.
- B의 실제 OpenSSH 설정·키/agent를 사용하는 전용 연결. 엄격한 host key 검사, 연결별 제어 소켓, master 유실 시 새 연결로 조용히 fallback하지 않는 보조 채널.
- C의 지속되는 Bash worker. 요청 사이 cwd·export·source 상태 유지, 사용자 출력과 분리한 완료 기록.
- SQLite 접수·명령 상태·요청 키 중복 방지. HTTP 응답 유실 뒤 결과 조회, 재시작 시 unknown/broken 판정.
- 긴 명령의 stdout/stderr 수집과 바이트 페이지 조회. C와 B 양쪽 로그를 제한하고 일반 빌드 파일에는 크기 제한을 걸지 않음.
- 명령 직렬 실행, 강제 취소·deadline, 셸 상태 손실 표시, 경과 시간에 기반한 제한 시간 판정.
- 원격 파일 목록·읽기·SHA-256 버전 검사·unified diff 적용·git 상태와 diff 조회.
- CLI, 설정 예시, 사용자 systemd 서비스와 HTTPS 프록시 예시, Copilot/VS Code 설정 예시.

## 설계 대비 구체화·제한

- 기본 파일 도구는 Python 3.9 이상을 C에서 일회성 SSH 도우미로 사용합니다. C에 새 수신 포트나 상주 서비스는 설치하지 않습니다. 파일 전송은 보조 SSH 채널로 처리하므로 실제 구현에 SFTP subsystem은 필요하지 않습니다.
- 셸 worker는 `setsid --wait`로 유지합니다. 제어용 FD 3, `__sm_*` 변수·함수명은 예약합니다. 초기화 때 Python과 mkfifo의 경로를 고정해 사용자 PATH 변경이 명령 추적을 깨뜨리지 않게 합니다.
- `read_file`은 한 번에 1 MiB 이하 UTF-8 일반 파일을 읽습니다. 부분 파일 조회·바이너리·rename·권한 변경·새 부모 디렉터리 생성은 범위 밖입니다.
- 출력은 스트림별 기본 1 MiB, 최대 10 MiB입니다. 출력 상한 뒤에는 추가 바이트를 버리며 프로그램의 stdout/stderr를 계속 소모합니다. 원격 명령 완료 후 해당 spool 파일을 정리합니다.
- 강제 취소는 셸 프로세스 그룹 전체를 끝냅니다. 탈출한 백그라운드 프로세스 회수·영속 터미널 복구·PTY는 구현하지 않았습니다.
- 요청 키와 명령 메타데이터는 재실행 방지를 위해 보관합니다. 출력 보관 24시간과 별개이며 명령 이력 10,000개에 도달하면 새 실행을 거부합니다. 감사 로그 회전과 전체 디스크 용량 관리는 운영 설정이 필요합니다.
- 파일 경로·해시 검사와 서버 내부 직렬화는 제공하지만 외부 편집자와의 완전한 CAS, 여러 파일의 원자적 트랜잭션, 적대적인 같은 OS 계정에 대한 격리는 제공하지 않습니다.
- Tabby는 생명주기 구조의 설계 참고이고 실행 의존성이 아닙니다. 실제 이식 코드는 tabby-mcp-server의 페이지 경계 계산을 적응한 작은 모듈입니다. 전체 Tabby SSH 엔진을 포팅했다고 주장하지 않습니다.

## 실행한 검사

| 검사 | 결과 | 근거 범위 |
| --- | --- | --- |
| `npm run build` | PASS | TypeScript 컴파일, worker 자산 복사 |
| `npm test` | PASS, 3개 | 서명된 JWT의 정상/실패 조건, SQLite 소유자·요청 충돌·재시작 복구, 설정 거부 |
| `npm run test:ssh` | PASS, 5개 통합 시험 | 임시 키와 loopback 고포트의 실제 sshd, 실제 OpenSSH, 실제 HTTP MCP SDK 클라이언트 |
| `npm run test:soak` | PASS, 1개 | 121초 명령, 진행 출력 조회, 완료 후 셸 환경 유지. 시험 실행 약 122.5초 |
| `npm run smoke` | PASS | 빌드된 dist의 서버 기동, health, 2026-07-28 프로토콜 고정 클라이언트의 인증된 도구 발견 14개와 실제 호출. SSH 통합 시험은 2025 호환 경로도 확인 |
| `node dist/cli.js --help` | PASS | 빌드된 CLI 실행 |

주요 환경: Linux, Node.js 22.23.2, npm 10.9.8. 정확한 npm 의존성 버전은 package-lock.json에 고정했습니다.

SSH 시험은 B와 C 역할을 같은 기계의 별도 SSH 연결로 구성한 로컬 통합 검증입니다. 실제 별도 PC, 인터넷 구간, 사용자 SSH agent·점프 호스트, 사용자 파일은 사용하지 않았습니다. 기존 SSH 설정과 known_hosts를 변경하지 않았습니다. 실패한 초기 시험의 소유 프로세스는 종료했고, 최종 시험은 자체 정리합니다.

## 수용 항목별 판정

| 설계 항목 | 결과 | 검증 또는 남은 조건 |
| --- | --- | --- |
| A01 실제 VS Code Copilot | NOT RUN | HTTP MCP SDK 클라이언트 검증만 수행 |
| A02 B의 인증정보로 접속 | PASS / NOT RUN | 임시 SSH config·개인키 PASS, 실제 agent·ProxyJump NOT RUN |
| A03 셸 상태 유지 | PASS | 별도 요청의 cd·export·venv source, PATH 변경 뒤 관리 셸 유지 |
| A04 장시간 명령 | PASS | 121초 실행, 진행 출력과 완료, 후속 환경변수 확인 |
| A05 원격 수정과 재시험 | PASS | Python 코드의 실패 → 패치 → 성공, 파일 해시 충돌 거부 |
| A06 HTTP 단절과 중복 방지 | PASS | 접수 뒤 응답 대기 중 abort, 요청 키 재조회·재전송, 부작용 1회 |
| A07 SSH 연결 손실 | PASS | 실제 SSH master 강제 종료로 연결 유실 재현, unknown·자동 재실행 금지 |
| A08 소유자·인증 | PASS | 미인증 HTTP 거부, 타 소유자의 ID 조회 거부. OS 다중 사용자 격리 검증은 아님 |
| A09 host key·agent | PASS / NOT RUN | 미등록 host key 거부 PASS, 실제 agent 부재/잠금 시나리오 NOT RUN |
| A10 충돌·경로 탈출 | PASS | 해시 불일치, `..`, 외부 디렉터리 symlink 거부 |
| A11 종료·시간 초과·취소 | PASS | 비영 종료, worker exit→unknown, timed_out, 취소와 셸 상태 손실 |
| A12 동시 실행 | PASS | 같은 세션의 두 번째 명령 거부, 기존 명령 완료 |
| A13 출력·재시작·디스크 | PASS / NOT RUN | 출력 제한·완전성 표기와 SQLite 재시작 복구 PASS, 실제 디스크 고갈 NOT RUN |
| A14 여러 파일 중간 실패·외부 편집 경쟁 | PASS / NOT RUN | 두 번째 파일의 부모 디렉터리 쓰기 권한 거부를 이용한 실제 중간 실패와 partial_apply PASS, 동시 외부 편집 경쟁 강제 주입 NOT RUN |
| 외부 OAuth 로그인·공개 HTTPS | NOT RUN | 로컬 JWT 검증을 실제 IdP 전달·Copilot 로그인 증거로 간주하지 않음 |

## 다음 실제 환경 검증

운영 안내에 따라 B의 설정에 C의 SSH 별칭·workspace를 등록하고, HTTPS 주소·IdP·서비스 계정 환경을 구성해야 합니다. 사용자 PC의 VS Code에서 실제 도구 호출, 원격 코드 수정과 테스트까지 확인한 뒤 A01과 외부 연동 항목을 갱신합니다. 이 정보가 없는 상태에서 임의의 사용자 원격지에 접속하거나 공개 서비스를 배포하지 않았습니다.
