# v0.2 구현·검증 결과

작성일: 2026-10-21. **로컬 추가 기능 구현: 완료/PASS. 운영 출시: NO-GO.** 사용자 환경 Copilot, 외부 IdP, 공개 HTTPS는 여전히 미검증입니다.

## 완료한 범위

설계에서 정한 다섯 도구를 모두 구현했습니다. 기존 14개와 합쳐 19개입니다.

| 기능 | 도구 | 결과 |
| --- | --- | --- |
| 실행 중 UTF-8 입력·EOF | run_command inputMode=pipe + send_input | PASS |
| 완료 대기 | wait_command | PASS |
| 제한된 원격 코드 내용 검색 | search_files | PASS |
| 소유자·세션별 명령 이력 | list_commands | PASS |
| 명시적인 새 셸 세대 | reopen_session | PASS |

입력 요청 중복·내용 충돌·메시지/누적 한도·EOF 이후 입력·소유자 검사를 포함합니다. 입력 ACK 유실 시 unknown으로 남기고 자동 재게시와 후속 입력을 막습니다. 해당 ACK 유실 시험은 게시 자체는 실제 SSH를 사용하고 응답 손실만 시험용으로 주입했습니다.

기존 SQLite의 명령을 접수 순서 테이블로 옮기고, 그 후에는 상태 변경과 무관한 순서 커서를 사용합니다. 기존 closed-input 명령의 중복 방지 해시를 유지해 v0.1 요청 기록과 호환됩니다. 재시작 때 접수 중 입력도 unknown으로 복구합니다.

입력 전용 FIFO와 feeder를 추가했으며 프로그램 완료·취소 때 정리합니다. worker 자체가 exit로 종료되는 경우도 feeder가 부모 생존을 확인해 끝나도록 했고, 실제 SSH 프로세스 그룹에 남은 비좀비 프로세스가 없는지 검사했습니다.

## 자동 검증

| 검사 | 결과 | 범위 |
| --- | --- | --- |
| npm run build | PASS | TypeScript 컴파일 및 runner 자산 복사 |
| npm test | PASS, 3개 | JWT 검증, 설정 거부, 저장/재시작 복구(입력 포함) |
| npm run test:ssh | PASS, 5개 | v0.1 실제 SSH·HTTP·패치 회귀 |
| npm run test:v02 | PASS, 6개 | 입력·EOF·한도·중복·취소·재개·검색·이력·ACK 손실·HTTP 도구 호출·feeder 회수 |
| npm run smoke | PASS | 빌드된 HTTP MCP 서버, 2026-07-28 연결, 도구 19개 발견·호출 |
| 121초 soak | NOT RUN(이번 버전) | v0.1 기록은 보존. v0.2에서 장시간 시험을 다시 수행한 것으로 표시하지 않음 |

총 14개 자동 시험이 통과했습니다. [검사 로그](../test-results/v02/check.log)에 실제 출력과 종료 결과를 보관했습니다. 기본 check 명령에도 새 통합 시험을 포함했습니다.

## 기존 Docker 대상의 현재 Codex 시험

기존 컨테이너 ID `d6163ace6412a61203f37448462bd584567d95f45fa9f72635bc07a11a21d3f4`와 프로젝트를 그대로 사용했습니다. MCP 서버만 v0.2 빌드로 갱신했습니다.

- HTTP MCP 도구 19개와 v0.2 서버 정보를 발견했습니다.
- 입력 대기 중인 Python 프로그램의 `name> ` 출력을 읽고 `코덱스\n`과 `추가 입력`+EOF를 보냈습니다.
- 첫 입력 요청을 두 번 호출했지만 같은 inputId/sequence 1을 반환했고, 프로그램에는 한 번만 반영됐습니다.
- 완료 대기로 종료 코드 0을 확인했고, 출력은 `hello=코덱스`, `rest=추가 입력`이었습니다.
- 후속 명령의 환경변수 `marker=kept`가 유지됐고, 이전에 수정한 프로젝트 테스트 5개도 모두 통과했습니다.
- pricing.py 검색 결과를 행 10/11의 두 페이지로, 명령 이력을 서로 다른 명령의 두 페이지로 조회했습니다.
- closed 세션을 다시 열어 다른 sessionId, generation 2, previousSessionId를 확인했습니다. 중복 reopen은 같은 새 ID를 반환했고, 이전 환경은 `restored=unset`이었습니다.

[기계 판정 보고서](../test-results/v02/docker/report.json), [실제 MCP 요청·응답](../test-results/v02/docker/transcript.jsonl), [입력 프로그램 출력](../test-results/v02/docker/interactive-output.txt), [기존 프로젝트 재시험](../test-results/v02/docker/regression-tests.txt)을 남겼습니다.

AI 판단은 현재 Codex 대화가 했으며 별도 AI API는 호출하지 않았습니다. MCP SDK 어댑터를 통한 호출입니다. Codex 네이티브 MCP 등록·핫리로드를 검증한 것은 아닙니다. v0.1 원본 호출 기록에는 새 호출을 섞지 않았습니다.

## 범위와 제한

- stdin 파이프 지원이며 PTY·화면 터미널·터미널 크기 변경·Ctrl+C 전달은 범위 밖입니다.
- published는 원격 큐 게시 확인이며 프로그램의 소비 완료와 다릅니다. unknown 입력은 재전달하지 않습니다.
- reopen은 새 셸입니다. 이전 cwd·환경·가상환경·명령을 자동 재현하지 않습니다.
- 검색은 UTF-8 리터럴과 제한된 파일 범위이며 전체 저장소 색인·정규식·스냅샷 검색이 아닙니다. 제외·상한·읽기 실패를 응답에서 확인해야 합니다.
- 소유자 검사는 OS 계정 분리나 다중 사용자 격리 증명이 아닙니다. 서버 재시작 후 살아 있는 원격 작업 복구와 외부 운영 수용은 미검증입니다.

기존 컨테이너와 호스트 MCP 서버는 실행 상태로 남깁니다. 업데이트를 다시 적용할 때는 `node scripts/docker-demo.mjs reload`를 사용하며, 이는 활성 명령에 영향을 줄 수 있습니다.
