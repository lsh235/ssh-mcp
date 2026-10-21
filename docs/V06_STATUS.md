# v0.6 감사 로그 회전 검증

v0.6은 단일 audit.jsonl을 제한된 활성 파일과 무제한 보관 구간으로 나눕니다. 구간을 닫을 때 audit_segment_end를, 다음 구간에는 이전 해시를 가리키는 audit_segment_start를 기록합니다. 보관 파일명에는 시작/끝 순번과 끝 해시가 들어가며, 서버 기동과 audit:verify는 보관 파일을 순서대로 모두 읽어 연속성을 검사합니다. 이전 버전의 JSONL 원문과 v0.5 체인은 최초 구간에서 계속 검증됩니다.

전환은 먼저 끝 마커를 fsync하고 새 구간의 staging 파일을 fsync한 뒤, 현재 파일을 hard link로 보존하고 이름을 교체합니다. 구간 교체 중 종료된 경우 서버 기동 시 staging 상태와 이전 구간을 확인해 이어가며, 모순·손상·누락이면 fail-closed합니다. audit.maxFileBytes 기본값은 10 MiB이며 16 KiB~1 GiB로 설정할 수 있습니다.

오래된 구간은 자동 삭제하지 않습니다. 그러므로 활성 파일 크기만 제한되고 전체 감사 저장공간은 계속 증가합니다. 전체 체인은 외부 서명/anchor를 사용하지 않으므로, stateDir 전체를 다시 쓸 수 있는 주체가 모든 구간을 재작성하는 것을 막지 못합니다. 중간 구간 삭제와 내부 변조는 검사하지만, 외부에 고정된 마지막 head가 없으면 공격자가 최신 꼬리를 잘라낸 사실도 증명할 수 없습니다.

## 업스트림 조사와 판단

조사한 [tufantunc/ssh-mcp audit/store.ts](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/audit/store.ts)는 100 MiB 활성 파일과 10개 번호 보관 파일을 사용하고 활성 파일 끝에서 해시를 다시 읽습니다. 보관 파일 전체의 연속성 검증은 해당 파일에서 확인하지 못했습니다. Shell MCP는 회전 아이디어만 적용하고, 전체 세그먼트를 보존·검증합니다. 분류기/승인 기능은 해당 업스트림 [보안 권고](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/SECURITY.md)를 보고 별도 검증 대상으로 남겼습니다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| npm run check 빌드 + unit/SSH/v0.2/login/browser 시험 | PASS, 36개 시험 |
| 회전·구간 체인 | PASS: 파일 크기 제한, 재시작 이후 연속 순번·해시, 보관 구간 수와 레코드 수 일치 |
| 구간 손상·누락 | PASS: 보관 구간 삭제를 verifier가 거부 |
| 전환 복구 | PASS: .next 승격 전과 hard link 생성 후의 중단 상태 복구 |
| 동시성 | PASS: 활성 작성 중 verifier와 두 번째 작성자를 잠금으로 거부 |
| 설정 | PASS: 기본 10 MiB, 16 KiB 최소, 1 GiB 최대 검증 |
| 컴파일된 서버 npm run smoke | PASS: health, 인증된 MCP 발견·도구 호출, 20개 도구 |
| 회전된 다중 구간에 대한 CLI 검증 | PASS: 보관 구간과 활성 로그 전체 검사 |
| 121초 soak | NOT RUN |
| 실제 사용자 VS Code/Copilot, 공개 HTTPS·외부 IdP | NOT RUN |

따라서 저장소 빌드·회귀와 로컬 격리 SSH/HTTP 검증은 통과했지만, 실제 Copilot 수용과 운영 배포는 별도입니다. 상세 설정은 [OPERATIONS](OPERATIONS.md)를 확인하세요.
