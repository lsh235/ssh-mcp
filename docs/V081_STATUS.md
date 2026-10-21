# v0.8.1 고아 전송 작업 디렉터리 정리

작성일: 2026-10-22 (Asia/Seoul).

**코드·격리 OpenSSH 검증: PASS.** v0.8의 브라우저 파일 전송 결과는 유지하면서, MCP 서버가 비정상 종료한 뒤 C의 세션 임시 디렉터리에 남을 수 있는 부분 업로드 파일을 제한적으로 정리합니다. 부분 파일을 이어 쓰거나 자동 재실행하지 않습니다.

## 조사와 판단

업스트림의 고정 리비전 [`tufantunc/ssh-mcp` SFTP adapter](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/ssh/sftp.ts)는 stream 업로드를 형제 `.part` 파일에 기록하고 실패 경로에서 임시 파일을 정리합니다. 같은 리비전의 [transfer tools](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/tools/transfer-tools.ts)는 다운로드 staging을 `finally`에서 정리합니다. [OpenBSD sftp(1)](https://man.openbsd.org/sftp.1)는 `-a` 이어쓰기 중 기존 부분 내용이 다르면 결과가 손상될 수 있다고 설명합니다.

따라서 Shell MCP는 offset만으로 자동 resume하지 않습니다. v0.8 remote worker spool은 C의 OS temp 경로에 있으며 정상적인 SSH close 때 제거됩니다. 프로세스 비정상 종료 뒤 남는 디렉터리는 다음 새 worker의 `prepare`에서만 검사합니다.

## 정리 조건

- 이름이 `shell-mcp-*`인 temp 하위 항목만 후보입니다. 후보는 현재 SSH 계정 소유의 실제 디렉터리여야 하며 권한은 정확히 `0700`이어야 합니다.
- 디렉터리 수정 시각이 24시간보다 오래되어야 합니다. 현재 worker가 실행 중인지 PID와 Linux `/proc/<pid>/stat` 시작 시각을 비교합니다. 같은 프로세스가 살아 있으면 오래되어도 건드리지 않습니다.
- trusted 형태의 regular `identity` 파일과 죽은 프로세스를 확인한 뒤, 디렉터리 바로 아래의 regular file/symlink만 제거하고 디렉터리를 비웁니다. 재귀 삭제는 하지 않습니다.
- symlink directory, identity 누락/오류, 권한·소유권 불일치, nested directory, socket/device 등 특수 파일, 검사 상한 초과는 그대로 둡니다. cleanup은 best-effort라 실패가 새 SSH 연결을 막지 않습니다.
- 한 번의 검사에서 temp entry 최대 5,000개, 후보 디렉터리별 최대 10,000개를 조사합니다. 다음 연결이 없으면 stale spool은 남아 있습니다.
- 전송 기록은 `unknown` 상태를 유지합니다. 삭제할지 재개할지 추론해 명령을 재실행하지 않습니다.

## 검증 결과

`npm run check` PASS: build, unit 14개, 격리 OpenSSH 6개, v0.2 통합 8개, postLogin 9개, browser API 3개(총 40개). SSH 시험은 오래된 dead-worker spool 제거, 오래된 live-worker 보존, 최근 항목 보존, identity 없는 경로 보존, 중첩 디렉터리 보존을 확인합니다. `npm run smoke`도 PASS로 health, 인증된 MCP tool discovery와 호출(20 tools)을 검증했습니다. `node dist/cli.js --version`은 `0.8.1`을 출력합니다.

## 미검증 범위

- 여러 MCP host 프로세스가 같은 OS 계정을 사용하고 같은 `/tmp`를 공유하는 운영 배포에서의 장기 동시성·대규모 temp 디렉터리 탐색은 검증하지 않았습니다.
- PID namespace가 달라 `/proc`의 프로세스 identity가 SSH worker와 다르게 보이는 환경에서는 cleanup이 보수적으로 건너뛸 수 있습니다.
- 실제 다중 PC/ProxyJump 대상, 사용자 VS Code/Copilot, 외부 HTTPS 배포는 별도 수용 시험입니다.
