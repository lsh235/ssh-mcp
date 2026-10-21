# v0.3 추가 로그인 기능 검증

대상별 postLogin 설정으로 SSH 인증 성공 후 추가 로그인·보안 게이트 입력을 지원합니다. 비밀은 B의 비공개 파일·환경변수에서 읽으며, 로그인한 동일 채널로 개발용 Bash와 파일 도우미를 관리합니다. MCP 도구는 기존 19개입니다.

[사용법](LOGIN_SETUP.md) · [설정 예시](../examples/config.post-login.example.json) · [변경 전 기준 커밋과 해시](../test-results/login/baseline.json)

## 판정

로컬 기능·회귀 검증 **PASS**입니다. 실제 사용자 환경의 운영 출시 판정은 **NO-GO**이며 별도 수용 검증이 필요합니다.

| 항목 | 결과 |
| --- | --- |
| `npm run check` 안의 빌드 | PASS |
| 기존 단위/실제 SSH/v0.2 회귀 시험 | 14개 PASS |
| 추가 로그인 시험 | 9개 PASS |
| `npm run smoke` | PASS: 컴파일된 서버 기동, 인증된 MCP 도구 발견·호출 |
| 컴파일된 서버 + 실제 HTTP MCP + 격리된 SSH 게이트 | PASS: 두 입력, 지속 셸 상태, 7회 도구 호출 |
| 공개용 설정 템플릿 | 서버 스키마 검사 PASS |

추가 로그인 시험은 화면 문구 분할 수신·ANSI 처리, 환경변수/비공개 파일의 순차 입력, 특수문자·한글 전달, echo된 값의 비공개, 같은 연결의 파일 패치·git·stdin·긴 메시지, 취소·재열기, 잘못된 문구·입력·준비 신호, 비밀 참조 검증, helper 출력·시간 제한을 확인했습니다. 일반 SSH 대상과 게이트 대상의 동시 작업도 확인했습니다.

SSH master를 실제 강제 종료한 시험에서 진행 명령의 unknown 처리와 관리 worker 종료를 확인했습니다. 사용자 프로그램이 별도 프로세스 그룹으로 벗어나는 경우까지 정리를 보장하는 시험은 아닙니다.

기록: [전체 체크](../test-results/login/check.log), [스모크](../test-results/login/smoke.log), [컴파일된 게이트 실행](../test-results/login/compiled-runtime.json). 원본은 가짜 자격정보를 쓰는 격리된 실제 sshd이며, 실제 사용자 장비의 로그인 화면을 관찰한 결과가 아닙니다.

실제 사용자 게이트, 네이티브 Copilot/Codex 등록, 외부 HTTPS, 외부 OAuth, 이번 변경의 121초 soak는 NOT RUN입니다. 실제 사용자의 입력값은 코드·문서·시험 파일에 넣지 않았습니다.
