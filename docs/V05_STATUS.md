# v0.5 감사 기록 개선 검증

v0.5은 감사 기록을 단순 JSONL 이벤트에서 순번과 SHA-256 이전 해시를 가진 연결형 JSONL로 바꿉니다. 기존 v0.4 기록은 원문 줄을 유지하고 개수·전체 바이트 해시를 담은 시작 체크포인트를 덧붙여 이어갑니다. 서비스 기동 때 전체 파일을 검사하며, 저장소 잠금과 파일 권한 검사를 통해 같은 stateDir의 동시 작성·심볼릭 링크 교체를 거부합니다. 독립 `audit:verify` 명령으로 정지된 로그를 다시 검사할 수 있습니다.

명령·입력·패치 본문이나 게이트 비밀은 감사 기록에 넣지 않습니다. stdin 데이터는 원격으로 전달하기 전에 `input_requested` 메타데이터를 기록하고, 전달 결과는 상태만 기록합니다. 감사 기록이 준비되지 않았거나 쓰기에 실패하면 새 원격 명령·입력·패치를 보내지 않도록 합니다. 파일 전체를 다시 작성할 수 있는 공격자를 막는 전자서명/외부 anchor는 아니며, 자동 회전도 아직 지원하지 않습니다. 세부 운영 제한은 [OPERATIONS](OPERATIONS.md)를 확인하세요.

## 근거와 채택 범위

기능 후보는 웹에서 조사한 [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp/tree/5c5b8476492cda568fca779b307ff8a2ca0bbbb7)의 감사 이벤트·선택형 해시 연결·로그 관리 아이디어입니다. 이 저장소의 코드를 복사하지 않았습니다. 대신 `audit.jsonl`을 연속 검증하고 기존 기록을 보존하도록 Shell MCP의 OpenSSH·stateDir·본문 비저장 모델에 맞춰 구현했습니다. 전체 조사·라이선스·다음 이식 후보는 [UPSTREAM_REVIEW](UPSTREAM_REVIEW.md)와 [UPSTREAM_MIGRATION](UPSTREAM_MIGRATION.md)에 있습니다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| `npm run check` 빌드 + 전체 unit/SSH/v0.2/login/browser 시험 | PASS, 31개 시험 |
| 감사 체인 단위·통합 시험 | PASS, 생성/순서/해시 검증, 변조·삭제·불완전 줄 거부, v0.4 로그 전환·체크포인트, 단일 writer, symlink 거부, stdin intent의 사전 기록과 내용 미저장 |
| 실제 격리 OpenSSH 및 HTTP MCP 회귀 | PASS: persistent shell, 코드 패치·테스트, 입력 중복 안전, 로그인 게이트, 브라우저 보기 포함 |
| 컴파일된 서버 `npm run smoke` | PASS: health, 인증된 MCP 도구 발견 및 호출, 20개 도구 |
| `npm run audit:verify` 생성 로그 시험 | PASS: 새 시작 기록과 이벤트 포함 2개 체인 행 검증 |
| `npm run test:soak` 121초 | NOT RUN |
| 실제 사용자 VS Code/Copilot, 외부 HTTPS/IdP 및 외부 SSH 운영환경 | NOT RUN |

따라서 로컬 빌드·회귀와 해시 검증기는 통과했지만, 사용자 환경 수용 및 운영 배포 판정은 별도입니다. 감사 로그 파일을 정지한 뒤 검사해야 일관된 스냅샷을 얻습니다. 임의 삭제·절단·외부 회전은 현재 버전에서 지원되지 않습니다.
