# v0.4 브라우저 세션 보기 검증

현재 대화의 SSH 세션을 명시적으로 묶는 create_session_view 도구와 인증된 읽기 전용 웹 화면을 추가했습니다. run_command에는 비밀 없는 displayName을 선택적으로 지정할 수 있습니다. 총 MCP 도구는 20개입니다. [사용법·VS Code 소스 근거](VSCODE_BROWSER.md)와 [변경 전 기준](../test-results/browser/baseline.json)을 참조하세요.

로컬 기능·회귀 시험은 PASS이며 운영 출시 판정은 NO-GO입니다. 실제 VS Code Desktop·사용자 원격 환경의 수용 검증이 남아 있습니다.

| 검증 | 결과 |
| --- | --- |
| 빌드와 기존 단위/SSH/v0.2/추가 로그인 시험 | PASS, 기존 23개 |
| 새 브라우저 통합 시험 | PASS, 3개. 실제 SSH + MCP 보기 생성, 소유자·범위·Origin 검사, 출력·표시 이름·요청 충돌, 조회 전용, 재시작 보관, 정적 자원 정책 |
| 컴파일된 서버 smoke | PASS, 도구 20개 발견 및 인증된 호출 |
| Chrome 화면 검증 | PASS: 2세션, 이름·종료 코드·출력, 자동 출력 갱신, HTML 텍스트 처리, 저장소 미사용, 연결 해제 시 데이터 제거, 잘못된 토큰 거부, 재로딩 후 인증 필요 |
| 실제 VS Code Desktop Integrated Browser | NOT RUN: 현재 환경에 실행 파일 없음 |
| 실제 Copilot/Codex 네이티브 연결, 공개 HTTPS, 외부 IdP, 이번 변경의 121초 soak | NOT RUN |

기록: [전체 체크](../test-results/browser/check.log), [스모크](../test-results/browser/smoke.log), [컴파일된 서버 MCP 호출](../test-results/browser/compiled-runtime.json), [화면 검증](../test-results/browser/ui-validation.json), [VS Code 소스 리비전·범위](../test-results/browser/source-review.json). 화면과 테스트는 모두 가짜 자격정보·격리된 프로젝트를 사용하며 사용자의 실제 세션이나 비밀을 게시하지 않았습니다.

화면: [데스크톱](../output/playwright/session-monitor-desktop.png), [출력](../output/playwright/session-monitor-output.png), [작은 화면](../output/playwright/session-monitor-mobile.png), [어두운 테마](../output/playwright/session-monitor-dark.png).
