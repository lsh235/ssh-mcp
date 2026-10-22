# v0.10.0 durable 브라우저 업로드 재개

작성일: 2026-10-22 (Asia/Seoul).

브라우저 탭을 닫거나 MCP 서버를 재시작해도, C에 게시되기 전의 A→B 업로드를 B의 확인된 offset부터 복구할 수 있습니다. MCP 재시작은 SSH 셸을 복원하지 않습니다. 새 SSH 세션과 새 브라우저 보기를 만든 뒤 동일한 소유자·대상·workspace root·원격 경로에서 같은 파일을 다시 선택해야 합니다.

## 조사 근거와 설계

- [tus-js-client FAQ](https://github.com/tus/tus-js-client/blob/main/docs/faq.md)와 [사용 안내](https://github.com/tus/tus-js-client/blob/main/docs/usage.md)는 fingerprint와 Web Storage에 저장한 업로드 identity로 브라우저를 닫은 뒤 같은 파일을 다시 선택해 이어가는 흐름을 설명합니다. 이 서버는 자체 인증·view/session API를 유지하며 tus 호환을 주장하지 않습니다.
- Node.js [FileHandle.sync()](https://nodejs.org/api/fs.html#filehandlesync)는 업로드 청크를 동기화한 다음 SQLite confirmed offset을 저장하는 데 사용합니다. 기존 SQLite [WAL](https://sqlite.org/wal.html)과 [`synchronous=FULL`](https://sqlite.org/pragma.html#pragma_synchronous) 설정이 DB 커밋 순서를 뒷받침합니다.
- `localStorage`에는 같은 브라우저 origin에서 업로드를 다시 찾기 위한 UUID 요청 ID만 저장합니다. 파일 데이터와 Bearer token은 저장하지 않습니다. SQLite journal에는 owner, target/workspace/root, 경로, SHA-256 chunk manifest, 확인 offset, private staging 이름과 완료 영수증을 저장합니다.

청크 파일의 `sync()`가 끝난 뒤에만 offset을 SQLite에 기록합니다. 재시작 후 파일 길이가 DB offset보다 길면 확인되지 않은 꼬리를 버리고, 짧거나 chunk checksum이 다른 prefix면 offset을 0으로 되돌립니다. 따라서 ACK 유실·재시도는 서버가 저장한 offset을 기준으로 조정됩니다.

대기 중인 업로드는 24시간 비활성 뒤 만료됩니다. 기존 파일 크기·동시 업로드·총 staging 상한을 적용합니다. 새 세션으로 재결합할 때 target/workspace/root/path가 바뀌면 `REQUEST_CONFLICT`로 거부합니다. 게시를 시작하기 전에 journal을 `publishing`으로 표시합니다. 이 상태로 재시작하면 `unknown`으로 변환하고 자동 재실행하지 않습니다. C에 파일이 게시됐는지 확정하지 못한 경우 원격 경로를 확인해야 합니다.

## 검증

- `npm run check` PASS: build, unit 14개, 격리 OpenSSH 6개, v0.2 8개, postLogin 9개, browser integration 6개로 총 43개 시험.
- Browser integration의 새 재시작 시험 PASS: 첫 1 MiB offset 저장 후 MCP service/runtime을 교체하고, 다른 workspace의 같은 request ID는 거부한 뒤 동일 workspace의 새 SSH 세션에서 나머지 청크를 이어 게시했습니다. 완료 영수증도 다음 재시작 뒤 복구했습니다. `publishing` 상태로 저장된 시험 레코드는 `TRANSFER_UNKNOWN`으로 응답했고 자동 재호출하지 않았습니다.
- 실제 Chromium UI와 격리 OpenSSH로 32 MiB 파일 업로드를 실행했습니다. 첫 확인 청크 뒤 테스트 서버의 연결을 끊고 새 runtime/SSH 세션/view를 시작했습니다. 브라우저에서 새 보기를 열고 token을 다시 입력한 뒤 같은 파일을 재선택해 업로드를 완료했습니다. 원본과 원격 파일의 SHA-256은 모두 `953fffa5cc55a2456b73dbb4b33da699ed11dbef70df5447994469cd0485ef6c`입니다.
- `npm run smoke` PASS: 빌드된 HTTP server health, 인증된 MCP discovery와 20개 도구 호출. `node dist/cli.js --version`은 `0.10.0`을 반환합니다. `git diff --check` PASS.

실제 VS Code Desktop Integrated Browser/Copilot, 사용자 공개 HTTPS/OAuth, 장시간 soak, OS 강제 종료·전원 손실·디스크 고장 환경은 검증하지 않았습니다. Chromium 시험은 로컬 loopback과 격리 sshd를 사용했습니다. 구조 탐색에서는 codebase-memory MCP 도구가 이 실행 환경에 노출되지 않아 관련 service/storage/viewer 경로를 직접 읽고 확인했습니다.
