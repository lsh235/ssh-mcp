# v0.8 브라우저 파일 전송 검증

작성일: 2026-10-22 (Asia/Seoul).

**기능 구현과 격리 HTTP/SSH 시험: PASS. 실제 VS Code Integrated Browser·사용자 PC 파일 선택·외부 HTTPS 배포: NOT RUN.** 이 기능은 오픈소스 SFTP streaming의 목적을 A/B/C 배치에 맞게 새로 구현했습니다. upstream 코드를 복사하거나 새 런타임 의존성을 추가하지 않았습니다.

## 변경 동작

- 인증된 브라우저 session view에서 사용자가 로컬 파일과 C의 workspace 상대경로를 골라 업로드합니다. 브라우저→B의 HTTP body는 MCP tool arguments/results, stdout/stderr, 감사 이벤트에 넣지 않습니다.
- B는 파일 바이트를 1 MiB 이하 청크로 기존 인증 SSH 연결을 통해 C에 보냅니다. session helper를 재사용하므로 일반 SSH와 postLogin shell gateway 모두 기존 접속 경로를 유지하며, C에 상주 MCP 프로세스나 새 listening port, SFTP subsystem을 설치하지 않습니다.
- C는 최대 크기와 SHA-256을 확인한 임시 파일을 만들고, 완성되면 hard-link create-only로 최종 경로를 원자적으로 게시합니다. 이미 있는 파일, symlink, 절대 경로, `..`, workspace 밖 경로를 거부합니다. 기존 파일을 바꾸는 동작은 없습니다.
- 다운로드는 C에서 일반 파일을 임시 snapshot으로 복사하고 원본 메타데이터 변경과 checksum을 검사합니다. B는 최대 2 MiB 단위로 읽어 브라우저에 스트리밍하며 전송이 정상 완료되어야 완료로 기록합니다.
- 기본 최대 파일 크기는 64 MiB이며 설정 허용 상한은 256 MiB입니다. B의 임시 업로드 예약 용량은 최대 두 파일 크기, 활성 업로드는 최대 네 건입니다. 활성 다운로드도 최대 네 건으로 제한합니다. 요청 종료 시 B 임시 업로드를 지우고, 비정상 종료로 남은 `.upload` 파일은 다음 server 시작 시 정리합니다. 다운로드 종료·시간 초과 시 C snapshot을 정리합니다.
- 업로드 요청 ID와 내용 hash로 같은 요청의 완료 응답을 재조회합니다. 같은 키로 다른 내용은 충돌입니다. 원격 결과를 확정하지 못하거나 서버가 재시작되면 `unknown`으로 남기며 자동 재실행하지 않습니다. 완료 파일은 새 요청에도 기존 파일 충돌로 보호합니다.

## 검증 근거

`npm run check`는 PASS입니다: build, unit tests 14개, 실제 OpenSSH 통합 5개, v0.2 기능 8개, postLogin 9개, 브라우저 API 3개(총 39개). postLogin 통합은 두 줄 gate를 통과한 같은 SSH gateway에서 바이너리 업로드·다운로드도 확인합니다. `npm run smoke`도 PASS로 빌드된 서버의 health, 인증 MCP tool discovery와 호출을 확인했습니다(20개 도구).

`npm run test:browser`는 실제 격리 OpenSSH 서버·임시 키·HTTP MCP 서버를 사용합니다. 2 MiB를 넘는 바이너리 데이터의 업로드와 다운로드 바이트 동일성 및 SHA-256, 동일 request ID의 완료 재조회, 다른 내용으로 같은 키를 쓴 충돌, 기존 파일 보호, 미인증 요청, view 밖 세션, 비허용 Origin, 파일 크기 상한, 잘못된 MIME, symlink 경로 거부를 확인했습니다. B측 `stateDir/transfers` staging이 요청 종료 후 비었는지도 확인했습니다.

추가로 Playwright CLI로 로컬 Chrome 화면에 테스트 토큰을 직접 입력하고 session view를 열어, 사용자가 고른 `README.md`를 C의 테스트 workspace로 업로드한 뒤 같은 경로를 내려받았습니다. 원본과 내려받은 파일의 SHA-256은 `4461c45e550600a28577fe0bbf328c277a3d8a290a7c8b3546db7e91e9412eb0`로 같았습니다. 이는 임시 loopback sshd·로컬 브라우저의 시험이며 사용자 VS Code Desktop 통합 시험은 아닙니다.

`test/core.test.ts`에서 전송 상한·timeout 설정과 시작 상태 전송의 재시작 후 `unknown` 복구를 확인합니다. MCP smoke에서 health endpoint와 20개 도구 발견·호출을 확인했습니다.

## 남은 확인 사항

- 이번 SSH 시험에서 B와 C는 같은 테스트 호스트의 별도 loopback SSH 역할입니다. 실제 별도 PC, ProxyJump, 사용자 ssh-agent, 사용자 postLogin 장비에서 파일을 이동한 것은 아닙니다.
- 실제 VS Code Integrated Browser의 파일 picker, 다운로드 UI·경로, 브라우저 메모리 사용은 이 환경에서 실행하지 않았습니다. 브라우저 API 통합 시험은 Node HTTP client를 사용합니다.
- 외부 OAuth provider, 공개 HTTPS reverse proxy, 외부 방화벽, 사용자 Copilot session에서 MCP 도구와 browser 페이지의 조합은 확인하지 않았습니다.
- 페이지를 강제로 종료하거나 B가 비정상 중단된 경우 브라우저 request ID를 다시 얻지 못할 수 있습니다. 완료 파일은 덮어쓰지 않으며 B의 미완료 임시 업로드는 다음 기동 때 정리합니다. C의 고아 worker directory는 v0.8.1에서 다음 SSH 연결 때 안전 조건에 따라 정리합니다. 세부 시험과 제한은 [V081_STATUS](V081_STATUS.md)를 참조하세요.
- 사용자가 다운로드를 AI agent와 공유하면 브라우저에서 본 파일이 별도 AI context가 될 수 있습니다. 서버가 파일 바이트를 MCP 응답에 포함하지 않는다는 점과 클라이언트 공유 정책은 구분해야 합니다.

참고한 업스트림 구현·판단은 [UPSTREAM_REVIEW](UPSTREAM_REVIEW.md)와 [UPSTREAM_MIGRATION](UPSTREAM_MIGRATION.md)에 기록했습니다.
