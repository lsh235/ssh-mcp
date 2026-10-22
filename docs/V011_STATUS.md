# v0.11.0 postLogin 명령 출력 마스킹

작성일: 2026-10-22 (Asia/Seoul).

`postLogin`에 구성된 로그인 값이 인증 후 원격 명령 stdout/stderr로 출력되면 MCP 응답이나 브라우저 세션 보기로 전달되기 전에 동일 바이트 수의 `*`로 마스킹합니다. 기존 출력 byte cursor와 크기 제한 의미를 유지합니다.

## 조사 근거와 적용 범위

- `tufantunc/ssh-mcp` main `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`의 [CHANGELOG](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/CHANGELOG.md)는 2.19.2에서 설정된 sudo password를 명령 출력에서 scrub하도록 수정한 내용을 기록합니다. 2.20.0은 실행 전달 경로를 `safe`로 잘못 분류했던 명령 분류기 문제를 수정했다고 기록합니다. 이를 바탕으로 제한적인 출력 마스킹만 적용하고 classifier를 권한 경계로 가져오지 않았습니다.
- 소스 코드는 복사하지 않았고 새 dependency도 추가하지 않았습니다.
- B는 postLogin 입력 값을 SSH 세션에 필요한 기간 동안 byte buffer로 유지하고, 각 명령의 stdout/stderr는 저장 전에 exact-byte redactor를 통과합니다. 청크 사이의 후보 바이트를 보관해 분할된 비밀도 찾고, 완료·취소·연결 유실 시 마지막 후보를 처리합니다. 완전히 일치한 값은 같은 길이의 `*`로 교체하고, 스트림 끝의 비밀 접두부도 숨깁니다.
- 마스킹된 값은 기존 공통 출력 저장 파일에 기록되므로 MCP `read_output`과 브라우저 viewer가 같은 결과를 봅니다. 파일 읽기, 명령 본문/이력, 환경 변수와 원격 대상 자체 로그는 필터링하지 않습니다. 비밀이 ANSI 삽입·재인코딩으로 변형된 경우, 또는 서로 다른 명령 결과로 나뉘어 출력된 경우도 탐지하지 않습니다. 정상 출력에 비밀과 같은 바이트 문자열이 있으면 그 부분은 가려집니다.

## 검증

- `npm run build` PASS.
- `npm test` PASS: 18개. 신규 단위 시험은 polling 청크 경계, 겹치는 비밀 패턴, UTF-8 중간 바이트, 같은 길이, 종료 시 부분 접두부, 비밀 미설정 시 무변경을 확인합니다.
- `npm run test:login` PASS: 9개. 격리 OpenSSH gate에서 stdout/stderr 노출을 확인했고, 비밀 출력이 두 polling 응답에 나뉘는 경우에도 저장 결과·byte count·브라우저 view가 마스킹된 것을 확인합니다. 일반 SSH 동작과 기존 gate 실패·취소 경로도 통과했습니다.
- `npm run check` PASS: build와 전체 47개 단위·격리 OpenSSH·MCP·browser 통합 시험.
- `npm run smoke` PASS: health, 인증된 MCP 도구 발견과 20개 도구 호출.
- `npm run test:soak` PASS: 121초 SSH job의 live output, 완료 후 기존 셸 상태 유지를 확인했습니다.
- `node dist/cli.js --version`은 `0.11.0`을 출력했고 `git diff --check`도 PASS입니다.

실제 VS Code Copilot/Integrated Browser, 사용자 SSH 대상, TLS 배포는 이번 라운드에서 실행하지 않았습니다. 메모리 byte buffer를 0으로 덮는 동작은 프로세스 메모리 덤프·런타임 내부 문자열의 완전한 제거를 보증하지 않습니다.
