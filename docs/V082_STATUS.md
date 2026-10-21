# v0.8.2 검증된 업로드 재개

작성일: 2026-10-22 (Asia/Seoul).

v0.8 브라우저 파일 업로드가 중간에 끊겼을 때 같은 요청 ID와 살아 있는 SSH 세션으로 다시 시도하면 확인된 원격 prefix 뒤부터 이어 보냅니다. 같은 크기의 원격 조각이 손상된 경우에는 이어 쓰지 않고 안전하게 비운 뒤 처음부터 전송합니다.

## 조사 근거와 적응

- [tus resumable upload protocol 1.0](https://tus.io/protocols/resumable-upload)은 HEAD 응답에서 서버가 확정한 `Upload-Offset`을 확인하고, 그 offset에서 PATCH를 이어갑니다. 현재 offset과 요청 offset이 다르면 서버는 upload resource를 바꾸지 않고 409로 응답합니다. Shell MCP는 HTTP API 자체를 tus로 바꾸지 않고, 원격 SSH helper가 확정한 offset과 SHA-256 prefix를 재개 조건으로 사용합니다.
- [xunuo2345/ssh-mcp-toolkit](https://github.com/xunuo2345/ssh-mcp-toolkit/tree/eb495ba453e1b899b8a7d98caac7558e6609a968)은 `.part` 크기 기준의 이어쓰기와 최종 SHA-256 확인을 구현합니다. Shell MCP는 코드를 복사하지 않고, 이어쓰기 전에 전체 confirmed prefix의 SHA-256을 비교하는 검증을 더했습니다.

## 동작

1. 브라우저에서 같은 파일·경로·세션 조합은 같은 fingerprint가 됩니다. sessionStorage에는 요청 ID만 저장합니다. 사용자 Bearer token은 저장하지 않습니다.
2. 새로고침 또는 연결 오류 뒤 사용자는 다시 인증하고 같은 파일과 경로를 선택합니다. 브라우저는 동일한 요청 ID로 파일 전체를 MCP 호스트에 다시 보냅니다.
3. MCP 호스트는 현재 SSH worker가 관리하는 원격 transfer metadata의 확정 byte count와 sequence를 확인합니다. 파일의 미확정 tail은 checkpoint까지 자르고, metadata보다 파일이 짧으면 checkpoint를 0으로 되돌립니다.
4. SSH helper는 원격 prefix SHA-256을 계산합니다. MCP 호스트가 로컬 staged 파일의 같은 길이 prefix hash와 비교해 같을 때만 나머지를 보냅니다. 불일치하면 unpublished `.part`를 0으로 reset하고 원본 전체를 재전송합니다.
5. 최종 전체 SHA-256과 byte count가 확인된 뒤에만 기존 create-only atomic publication을 수행합니다. 같은 목적지 파일은 덮어쓰지 않습니다.

## 지원 경계

- 브라우저→MCP 호스트는 기존 단일 PUT이므로 재시도 시 파일 전체를 다시 보냅니다. 절약되는 구간은 MCP 호스트→SSH 대상입니다.
- 재개에는 MCP 프로세스와 같은 SSH session runtime이 살아 있어야 합니다. SSH 연결이 닫히거나 MCP 서버가 재시작되면 remote helper spool이 없거나 session이 broken이므로 자동 재개하지 않습니다. `SERVER_RESTART` 결과는 unknown으로 남고 재실행을 거부합니다.
- sessionStorage는 같은 탭의 새로고침에서는 유지되지만 새 브라우저 탭/프로필에 공유되지 않습니다. 사용자가 파일을 다시 선택해야 하며, 파일의 내용이 바뀌면 서버 request digest 충돌로 거부됩니다.
- 실제 VS Code Integrated Browser/Copilot, 외부 HTTPS 프록시와 다중 PC SSH 대상은 별도 수용 시험입니다.

## 검증

`npm run check` PASS: TypeScript build, unit 14개, 실제 격리 OpenSSH 6개, v0.2 통합 8개, postLogin 9개, browser/API·resume 4개로 총 41개 시험입니다. resume 통합은 응답 유실 후 미확인 tail 복구, 첫 청크 응답 유실 뒤 나머지 청크만 전송, 동일 길이 손상 prefix 초기화, `SERVER_RESTART` 상태의 재실행 거부를 확인했습니다.

`npm run smoke` PASS: 빌드 서버 health, 인증된 MCP tool discovery와 호출(20 tools). `node dist/cli.js --version`은 `0.8.2`를 반환합니다.

Playwright CLI가 구동한 실제 Chromium에서 격리 OpenSSH 대상에 2 MiB 파일을 업로드했습니다. 첫 원격 청크 ACK를 의도적으로 유실시켜 `unknown` 상태를 만든 뒤 페이지 새로고침, 재인증, 같은 파일 재선택 후 업로드가 완료됐습니다. sessionStorage에는 UUID 요청 ID만 있었고 fixture token은 없었습니다. 원본과 C의 최종 파일 SHA-256은 `44a8fe50a5b185f8c405181f013e4321b3d1371505b01601c7ee92438ed588ee`로 일치했습니다. 이 시험은 loopback HTTP와 격리 sshd를 사용했으며 VS Code Integrated Browser/Copilot 또는 외부 HTTPS 배포 시험은 아닙니다.
