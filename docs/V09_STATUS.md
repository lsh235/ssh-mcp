# v0.9.0 브라우저 업로드 재개·취소

작성일: 2026-10-22 (Asia/Seoul).

브라우저에서 MCP 호스트(B)까지 보내는 업로드를 1 MiB 청크로 나눴습니다. 네트워크가 끊기면 같은 파일·경로·세션으로 다시 시도할 때 B가 디스크에 확인해 둔 offset부터 이어 보냅니다. B에서 SSH 대상(C)까지는 v0.8.2의 검증된 원격 prefix 재개 경로를 계속 사용합니다.

## 웹 조사와 적용 판단

- [tus resumable upload protocol 1.0](https://tus.io/protocols/resumable-upload)은 서버가 확인한 `Upload-Offset`만 재개 위치로 인정하고, 클라이언트 offset이 다르면 409로 상태를 변경하지 않도록 규정합니다. 이 구현은 해당 실패 처리 원칙을 따릅니다.
- [tus-js-client FAQ](https://github.com/tus/tus-js-client/blob/main/docs/faq.md)는 파일 fingerprint와 서버 upload URL을 Web Storage에 저장해 이전 전송을 다시 찾는 흐름을 설명합니다. 여기서는 파일 바이트나 Bearer 토큰 대신 현재 보기·세션·경로·파일 메타데이터에서 만든 storage key와 요청 ID만 `sessionStorage`에 보관합니다.
- tus 표준의 HTTP API를 그대로 제공하지 않습니다. `/mcp` 서버의 인증·보기 소유권·SSH session ID에 맞춰 만든 내부 API이며, tus 호환성, 브라우저 종료 뒤 재개, 서버 재시작 뒤 재개를 주장하지 않습니다. upstream 코드를 복사하거나 의존성을 추가하지 않았습니다.

## 전송 흐름

1. 브라우저는 사용자가 고른 파일을 1 MiB씩 읽어 각 청크의 SHA-256 manifest를 계산합니다.
2. 인증된 `POST .../uploads`가 보기·소유자·session·workspace 경로를 확인하고 서버 staging을 엽니다. 같은 요청 ID는 현재 서버 offset과 완료 영수증을 반환하며, 같은 ID에 다른 manifest를 주면 충돌로 거부합니다.
3. 브라우저는 서버 offset에서 `PATCH .../uploads?path=...&requestId=...`를 보냅니다. 서버는 정확한 `Upload-Offset`, 예상 청크 길이와 SHA-256을 검사하고 private `0600` staging 파일에 씁니다. 파일 동기화가 끝난 뒤에만 다음 offset을 응답합니다. 불일치 응답은 현재 offset을 돌려주며 staging을 진행시키지 않습니다.
4. 재시도 때는 저장된 prefix를 chunk manifest와 다시 대조합니다. 손상되었거나 확인 크기와 파일 길이가 어긋나면 확정 offset을 0으로 되돌려 원본부터 다시 받습니다. `complete` 직전에도 전체 prefix를 다시 확인한 뒤 기존 B→C SSH helper를 호출합니다. 기존 전체 SHA-256 검증과 create-only 원자적 게시를 그대로 적용하고, 이미 있는 원격 파일은 덮어쓰지 않습니다.

브라우저의 **업로드 취소**는 현재 처리 중인 최대 1 MiB 청크의 서버 응답을 기다린 다음, 인증된 `DELETE .../uploads`로 미완성 B staging을 제거합니다. 취소 응답이 불확실하면 같은 요청 ID를 보존하고 취소 재시도를 제공합니다. C로 SSH 게시를 시작한 뒤에는 취소 버튼을 숨깁니다. 브라우저 취소가 이미 시작된 원격 SSH 작업을 중단한다고 주장하지 않습니다.

화면은 진행 중인 브라우저 전송량과 MCP 호스트가 응답으로 확인한 위치를 구분해 표시합니다. 청크 응답이 유실되면 요청 ID로 서버 offset을 다시 조회한 다음 그 위치부터 계속합니다. 완료 응답이 유실돼도 같은 요청 ID의 영수증을 조회합니다.

## 경계와 보안

- 청크 크기는 1 MiB, manifest는 최대 256개이며 설정된 파일 최대 크기와 동시 전송·staging 예약 한도를 적용합니다. 청크 수신은 `transferTimeoutMs` 제한을 받고, 비활성 업로드는 다음 viewer 요청 때 만료 정리합니다.
- 요청 ID만 탭의 `sessionStorage`에 보관합니다. 새로고침 뒤 사용자는 다시 인증하고 같은 파일과 경로를 선택해야 합니다. 다른 탭·브라우저 프로필 간 전송은 이어지지 않습니다.
- B 프로세스가 재시작되면 in-memory upload 상태와 미완성 staging이 정리되므로 A→B 업로드는 처음부터 다시 시작합니다. C→B 구간도 해당 SSH session runtime이 살아 있어야 재개할 수 있습니다.
- Bearer 인증, 세션 보기 소유자·세션 포함 여부, workspace 상대 경로, 파일 크기, checksum, 동시 전송과 staging 상한을 검사합니다. 토큰과 파일 바이트는 Web Storage, MCP 인자·결과, 명령 출력이나 감사 이벤트에 저장하지 않습니다.

## 검증

`npm run check` PASS: build, unit 14개, 격리 OpenSSH 6개, v0.2 기능 8개, postLogin 9개, browser/API 5개로 총 42개 시험입니다. 새 browser integration은 unauthenticated 요청 거부, manifest 변경 충돌, 잘못된 청크 checksum rollback, 확인 offset 응답과 재조회, stale offset 409, 같은 길이 손상 및 짧아진 confirmed prefix의 0 offset 복구, 업로드 미완료 상태, 2 MiB 초과 파일의 완료·재조회, 완료 전송 취소·중복 취소·완료 전송 취소 거부, C측 최종 파일 byte 동일성과 staging 정리를 확인합니다.

`npm run smoke` PASS: 빌드된 HTTP server health, 인증된 MCP discovery와 도구 호출 20개를 확인했습니다. `node dist/cli.js --version`은 `0.9.0`을 반환합니다.

Playwright가 실행한 실제 Chromium UI에서 2 MiB 파일 업로드 중 SSH helper의 첫 원격 청크 응답을 의도적으로 유실시켰습니다. 브라우저는 재시도 가능한 상태를 표시했고, 페이지를 새로고침한 뒤 토큰을 다시 입력하고 같은 파일을 재선택해 업로드를 완료했습니다. 원본과 C workspace 파일의 SHA-256은 모두 `44a8fe50a5b185f8c405181f013e4321b3d1371505b01601c7ee92438ed588ee`입니다. 별도 Chromium 흐름에서는 첫 1 MiB 청크가 B에서 확인된 뒤 취소 버튼을 눌러, 성공 메시지와 B staging 제거 및 C측 파일 미생성을 확인했습니다. 실제 VS Code Desktop Integrated Browser/Copilot, 공개 HTTPS, 외부 SSH 대상은 이 시험에 포함하지 않았습니다. 이 UI 시험은 B→C 응답 유실 재개, reload와 staging 취소를 검증하며, A→B PATCH 응답 자체를 강제로 유실시키는 시험은 별도 수행하지 않았습니다.
