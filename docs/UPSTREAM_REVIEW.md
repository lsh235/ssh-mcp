# 오픈소스 조사 근거

## 2026-10-22 v0.12.0: PTY 대화형 프로그램

[Tabby `shellChannel.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/shellChannel.ts)는 `xterm-256color`, 80×24 크기로 SSH session channel의 PTY를 요청하고 이후 터미널 resize를 분리해서 전달합니다. [RFC 4254](https://datatracker.ietf.org/doc/html/rfc4254)는 그 SSH protocol request(`pty-req`)와 `window-change`를 정의합니다.

[tufantunc/ssh-mcp의 고정 README](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/README.md)는 여러 프로필의 stateful interactive/background session과 세션 수명 제한을 제공합니다. [현재 보안 설명](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/SECURITY.md)은 persistent session이 명령별 문자열 분류와 별개인 권한 위험이라는 점도 기록합니다. 자체 OpenSSH 인증정보와 정책 분류가 필요한 설치 방식이므로 이 프로젝트보다 일반적으로 더 낫다고 볼 수는 없습니다. 프로젝트 배치와 host 권한 경계에 따라 선택해야 합니다.

Shell MCP는 해당 코드를 복사하지 않고, 기존 C의 Python PTY 프로세스와 Bash worker를 연결해 `open_terminal` 등 다섯 도구를 추가했습니다. app은 controlling PTY·TERM·크기/SIGWINCH를 보지만, SSH worker channel 자체는 non-PTY이며 protocol `pty-req`는 전달하지 않습니다. postLogin gateway의 같은 인증 channel을 유지하고 원격 게이트 값 출력 마스킹을 공유합니다. 시험·브라우저 한계는 [v0.12.0 기록](V012_STATUS.md), 상세한 적응 판단은 [마이그레이션 라운드](UPSTREAM_MIGRATION.md)에 있습니다.

## 2026-10-22 v0.11.0: postLogin 출력 마스킹

이번 웹 재조사에서 `tufantunc/ssh-mcp` main `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`의 [CHANGELOG](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/CHANGELOG.md)를 확인했습니다. 2.19.2는 설정된 sudo 비밀번호를 명령 출력에서 제거하는 수정과, NOPASSWD 상황에서 비밀번호가 wrapped command에 보일 수 있던 문제를 함께 기록합니다. 2.20.0은 `sqlite3`, `tar`, `gdb`, `make`, `ssh host cmd` 등 명령 실행 경로가 안전 명령으로 분류되던 문제를 고쳤다고 기록합니다. 반복되는 분류기 우회 보완은 문자열 분류를 이 프로젝트의 권한 경계로 채택하지 않을 이유를 다시 확인시킵니다.

Shell MCP는 sudo 실행 도구를 도입하지 않습니다. 대신 B에 안전하게 구성한 postLogin 값이 명령 결과에 다시 포함될 때의 직접적인 누출 경로를 막도록 해당 값을 세션 메모리에서 exact byte pattern으로 유지하고, 셸 명령 stdout/stderr를 출력 파일에 쓰기 전에 같은 길이의 별표로 마스킹합니다. 스트림 chunk 경계와 종료 시 미완성 접두부를 다루며 길이를 보존해 기존 출력 cursor를 유지합니다. 브라우저 viewer와 MCP 읽기는 동일한 마스킹된 파일을 봅니다.

이 구현은 업스트림 코드 복사가 아닙니다. 게이트 입력 정책과 출력 수집 위치에 맞춘 별도 코드이며, 비밀 패턴은 설정된 postLogin 값뿐입니다. ANSI 삽입·재인코딩된 값, 원격 파일을 의도적으로 읽는 `read_file`, 원격 대상의 로그, 명령 본문/이력은 마스킹 대상이 아닙니다. 일치로 인한 정상 텍스트 오탐도 가능합니다. classifier/approval 기능과 범용 secret scanner는 가져오지 않았습니다. 구현과 검증 범위는 [v0.11.0 검증 기록](V011_STATUS.md)에 있습니다.

## 2026-10-22 v0.10.0: 브라우저 종료·MCP 재시작 뒤 업로드 복원

[tus-js-client FAQ](https://github.com/tus/tus-js-client/blob/main/docs/faq.md)와 [사용 안내](https://github.com/tus/tus-js-client/blob/main/docs/usage.md)는 파일 identity와 Web Storage의 upload reference를 이용해 브라우저를 닫은 뒤 같은 파일을 다시 골라 이어가는 방식을 설명합니다. Shell MCP는 localStorage에 Bearer token이나 파일 내용을 저장하지 않고, origin 안에서 target/workspace/path/file identity와 연결되는 UUID 요청 ID만 저장합니다.

[Node FileHandle.sync()](https://nodejs.org/api/fs.html#filehandlesync)는 업로드 청크 데이터를 sync한 뒤 confirmed offset을 SQLite에 반영하도록 사용합니다. 기존 [SQLite WAL](https://sqlite.org/wal.html) 및 [`synchronous=FULL`](https://sqlite.org/pragma.html#pragma_synchronous) 설정과 함께 host-side journal을 만듭니다. 실제 filesystem power-loss durability는 본 라운드의 시험 범위가 아닙니다.

저장된 대기 upload는 24시간 idle 뒤 만료됩니다. MCP 서버 재시작은 SSH shell을 복원하지 않기 때문에 사용자는 새 SSH session과 새 browser view를 만들어 같은 소유자·target·workspace root·path를 제시해야 staging을 재결합할 수 있습니다. manifest가 달라지거나 다른 workspace를 쓰면 충돌을 반환합니다. publish marker 뒤 서버가 재시작되면 staging을 다시 실행하지 않고 `TRANSFER_UNKNOWN`으로 응답해 원격 상태 확인을 요구합니다. remote target C에 성공 여부가 불확실한 파일을 자동 덮어쓰지 않습니다.

실제 isolated OpenSSH 통합 시험은 offset 복구와 새 session rebind, 다른 workspace 거부, 완료 receipt 복구, uncertain publish 재실행 금지를 확인합니다. VS Code Desktop Integrated Browser/Copilot과 전원 손실/디스크 고장 시험은 이 검증에 포함하지 않았습니다. upstream 코드를 복사하거나 의존성을 추가하지 않았습니다.

## 2026-10-22 v0.9.0: 브라우저→호스트 업로드 재개 조사

[tus resumable upload protocol 1.0](https://tus.io/protocols/resumable-upload)은 현재 서버 offset과 다른 PATCH에 409를 반환하고 자원을 변경하지 않으며, 성공한 PATCH에서 서버가 확정한 `Upload-Offset`을 돌려주도록 규정합니다. [tus-js-client FAQ](https://github.com/tus/tus-js-client/blob/main/docs/faq.md)는 fingerprint로 이전 upload URL을 Web Storage에서 찾아 재개하는 흐름을 설명하고, 네트워크로 보낸 진행률과 서버가 수락한 chunk 완료를 구분합니다.

Shell MCP는 사용자 문제가 남아 있던 브라우저(A)→MCP 호스트(B) 구간에 이 설계 원칙을 적용했습니다. 브라우저가 1 MiB SHA-256 manifest를 만들고, 인증된 B가 private staging에 저장한 청크만 offset으로 확정합니다. 응답 유실 뒤 동일 요청 ID로 확인된 offset을 다시 읽고, 완료 시 기존 B→C SSH transfer를 호출합니다. 화면은 클라이언트 전송량과 B의 확인 offset을 별도로 표시합니다.

현재 viewer API는 tus 프로토콜 호환을 표방하지 않습니다. tus의 upload URL/HEAD/OPTIONS/프로토콜 헤더 대신 기존 bearer 인증·view/session 식별자와 create/PATCH/complete 경로를 사용합니다. 요청 ID만 같은 탭의 `sessionStorage`에 보관해 새로고침 뒤 재시도할 수 있으며, 브라우저 종료나 MCP 프로세스 재시작을 넘는 resume은 제공하지 않습니다. tus의 선택형 [Termination extension](https://tus.io/protocols/resumable-upload#termination)을 참고해 현재 브라우저→호스트 전송을 마친 뒤 미완료 staging을 지우는 인증 DELETE를 추가했습니다. B→C SSH 게시 단계의 중단 기능과 결합하지 않습니다. 소스 코드를 복사하거나 의존성을 추가하지 않았습니다. 실제 VS Code Integrated Browser/Copilot과 외부 HTTPS 배포는 검증하지 않았습니다.

## 2026-10-22 v0.8.2: 파일 전송 재개 조사

[tus 프로토콜 1.0](https://tus.io/protocols/resumable-upload)은 HEAD로 서버가 확정한 `Upload-Offset`을 확인한 뒤 같은 위치에서 PATCH를 이어가며, 서버 현재 offset과 요청 offset이 다르면 409로 upload resource를 변경하지 않도록 정의합니다. Shell MCP는 현재 단일 PUT 브라우저 API를 유지하므로 tus endpoint는 구현하지 않았고, 원격 helper에서 확정 offset을 되돌려 주는 아이디어만 적응했습니다.

고정 리비전 [`xunuo2345/ssh-mcp-toolkit`](https://github.com/xunuo2345/ssh-mcp-toolkit/tree/eb495ba453e1b899b8a7d98caac7558e6609a968)의 [전송 구현](https://github.com/xunuo2345/ssh-mcp-toolkit/blob/eb495ba453e1b899b8a7d98caac7558e6609a968/src/index.ts)은 `.part` 크기에서 재개 위치를 고르고 완료 시 SHA-256을 비교합니다. [resume tests](https://github.com/xunuo2345/ssh-mcp-toolkit/blob/eb495ba453e1b899b8a7d98caac7558e6609a968/test/resume.test.ts)는 크기가 같은 손상 partial에 대해 checksum 실패를 보이지만 조기 prefix 검증과 자동 초기화는 하지 않습니다. Shell MCP는 원격 confirmed checkpoint와 그 prefix의 SHA-256을 비교해 정확한 바이트가 확인될 때만 이어가고, 다른 경우에는 unpublished partial을 0으로 reset합니다. 업스트림 소스 코드는 복사하지 않았습니다.

브라우저는 HTTPS origin의 sessionStorage에 요청 ID만 유지하고 토큰은 저장하지 않습니다. 새로고침 후 파일 재선택은 같은 MCP 서버·같은 살아 있는 SSH 세션의 transfer ID에 연결됩니다. 서버나 SSH 프로세스가 재시작되면 복구할 remote spool이 없으므로 `SERVER_RESTART`를 재시도하지 않습니다. 현재 B→C 전송만 resume하며 브라우저→B 단일 body의 네트워크 재개와 실제 VS Code browser acceptance는 범위 밖입니다.

## 2026-10-22 v0.8.1: 고아 전송 조각 정리 재조사

고정 리비전 [`tufantunc/ssh-mcp` SFTP adapter](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/ssh/sftp.ts)는 stream 업로드를 sibling `.part`에 쓰고 게시 후 정리하며, 실패한 `.part`도 best-effort로 제거합니다. 같은 리비전의 [전송 도구](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/tools/transfer-tools.ts)는 다운로드 staging을 `finally`에서 정리합니다. 재접속 후 부분 파일 이어쓰기는 구현하지 않았습니다. OpenBSD [`sftp(1)`의 `-a`](https://man.openbsd.org/sftp.1)는 끊긴 전송을 이어갈 수 있지만 부분 내용이 다르면 결과가 손상될 수 있다고 경고합니다.

Shell MCP의 업로드 조각은 지속 서비스가 아니라 현재 SSH 세션의 private `/tmp/shell-mcp-*` 작업 디렉터리에 있습니다. 서버가 비정상 종료되면 C측 worker가 끝나도 그 디렉터리가 남을 수 있습니다. 바이트 오프셋만 믿는 이어쓰기는 source 재선택, 체크섬 prefix 검증, 원격 file identity·동시 변경 감시, 브라우저 재시작 뒤 권한 확인을 요구하므로 이번 라운드에서는 채택하지 않았습니다.

대신 새 SSH worker의 `prepare`가 24시간 이상 된 private 작업 디렉터리를 제한적으로 조사합니다. 저장된 PID와 `/proc/<pid>/stat` 시작 시각이 같은 살아 있는 프로세스는 나이에 관계없이 보존하고, dead/mismatched PID가 확인된 디렉터리만 지웁니다. 현재 사용자 소유·정확한 0700 디렉터리, 정규 `identity` 파일, 비재귀 파일 목록, scan/file count 상한을 검사합니다. 신원을 확인할 수 없거나 하위 디렉터리·특수 파일이 있으면 남겨 둡니다. 정리는 다음 연결 때만 실행되므로 대상에 재접속하지 않으면 조각이 계속 남을 수 있습니다. 기존 transfer 결과는 `unknown`으로 유지되며 자동 명령 재실행·전송 재개는 하지 않습니다.

## 2026-10-22 v0.8: 파일 streaming 재검토

`tufantunc/ssh-mcp`의 고정 리비전 `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`에서 [전송 도구](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/tools/transfer-tools.ts), [SFTP 계층](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/src/ssh/sftp.ts), [README](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/README.md)를 다시 읽었습니다. 소스는 별도 구현이며 코드 복사는 없습니다. 중요한 기능은 파일 내용을 AI tool result에 싣지 않는 streaming, server-private staging, 크기 제한, 중복/부분 실패 정리였습니다.

Shell MCP의 세 위치는 다릅니다. VS Code PC A가 선택한 파일을 B의 로컬 경로로 직접 읽을 수 없고, B가 인증 SSH 연결을 통해 C에 접근합니다. 그래서 browser의 명시적 파일 선택으로 A→B HTTP body를 만들고, B가 private staging 후 현재 SSH session helper 경로로 C에 업로드합니다. 다운로드는 C의 파일을 임시 snapshot/hash한 뒤 같은 browser response stream으로 A에 보냅니다. 이 방식은 existing postLogin shell gateway와 맞으며 SFTP subsystem 의존성을 추가하지 않습니다.

OpenBSD [`sftp(1)`](https://man.openbsd.org/sftp.1)은 SFTP 파일 전송과 batch interface의 독립 도구 경로를 설명합니다. postLogin 대상에서는 SFTP subsystem이 추가 로그인 gate를 통과한다고 보장할 수 없으므로, 기존 인증된 SSH exec channel 안의 Python helper를 사용했습니다. Browser endpoint는 MCP tool arguments/results와 분리하지만 기존 토큰 권한을 그대로 사용하고, 사용자가 업로드 파일과 원격 경로를 직접 선택합니다.

최종 구현은 64 MiB 기본/256 MiB 최대 크기, private B staging, SHA-256, 1 MiB/2 MiB 전송 chunk, C측 임시 snapshot, create-only 게시, 파일 충돌 거부, bounded concurrent transfers, 세션·view 소유권, 감사 결과, 불확실한 요청의 unknown 처리로 범위를 제한합니다. 자세한 동작·제한·격리 sshd 시험은 [V08_STATUS](V08_STATUS.md)에 기록했습니다. 실제 VS Code Integrated Browser, 실제 사용자 파일 picker/download, public HTTPS는 검증하지 않았습니다.

## 2026-10-22 v0.7: bounded 파일 목록 재조사

`tufantunc/ssh-mcp` main `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`의 [README](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/README.md)와 [CHANGELOG](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/CHANGELOG.md)를 웹에서 다시 확인했습니다. README는 제한된 `sftp-list`와 모델 context를 거치지 않는 file streaming을 설명합니다. 이 프로젝트는 현재 B의 로컬 transfer path가 A의 사용자 workspace를 가리키지 않으므로 streaming 전송을 보류하고, workspace 내부 bounded listing만 채택했습니다. OpenBSD `sftp ls -l`의 상세 목록을 참고해 metadata를 추가하되 [stat(2)](https://man.openbsd.org/stat.2)의 `lstat` 의미대로 symlink 자체만 봅니다.

같은 upstream CHANGELOG는 2.20.0에서 command classifier가 `make`, `ssh host cmd`, privilege broker 등 실행 전달 경로를 놓쳤던 문제와 수정을 기록합니다. 이를 포함한 반복 수정 이력 때문에 문자열 분류기를 권한 경계로 포팅하지 않습니다. VS Code의 [MCP tool confirmation 문서](https://code.visualstudio.com/api/extension-guides/ai/mcp)는 쓰기 도구 확인 UI를 설명하지만, 실제 사용자 Copilot에서 확인하지 않았으므로 별도 elicitation 승인 기능도 아직 추가하지 않았습니다.

Shell MCP v0.7은 upstream 코드를 복사하지 않았으며, Python SSH helper에 10,000 항목/8 MiB 수집 상한, cursor page, `incomplete` 사유, `lstat` 기반 metadata를 독립 구현했습니다. 자세한 시험 경계는 [V07_STATUS](V07_STATUS.md)에 기록했습니다.

## 2026-10-22 추가 조사: tufantunc/ssh-mcp

이번 라운드에서 [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp)의 기본 브랜치와 웹 문서를 확인했습니다. 기준 리비전은 `5c5b8476492cda568fca779b307ff8a2ca0bbbb7`입니다. README, SECURITY, 세션 관리자, SSH 연결 어댑터, HTTP transport와 감사 저장소를 살펴봤습니다. 원본을 이 저장소에 설치하거나 실행하지 않았고, 특정 구현 파일을 복사하지 않았습니다.

| 검토 기능 | 프로젝트에 맞는 점 | 적용 판단 |
| --- | --- | --- |
| 세션별 SSH 프로필·대화형/background 명령 | 여러 SSH 대상·세션 사용이라는 목표와 맞음 | 세션 소유권·지속 Bash·OpenSSH 설정을 이미 갖춘 현재 모델을 유지하고, 실행 모드 변경은 별도 요구가 있을 때 검토 |
| 위험 명령 분류와 승인 | 명령 실행 전에 사용자 판단을 받는 선택지는 유용함 | 문자열 기반 파괴성 분류는 우회가 가능하다는 원본 보안 경고를 반영해 그대로 이식하지 않음. 향후 VS Code MCP elicitation 지원과 명시적 정책 경계를 함께 검토 |
| JSONL 감사·비밀 마스킹·회전·선택형 해시 연결 | 원격 개발의 실행 이력을 남기고 조작 여부를 점검하는 요구와 맞음 | v0.5에서 해시 체인을 도입하고 v0.6에서 무제한 보관 구간·구간별 체인 연결·기동 시 전체 검증·회전 복구를 독립 구현 |
| 직접 SSH 라이브러리와 프로필 자격정보 | 한 서버가 여러 접속정보를 직접 가질 때 유용할 수 있음 | 본 프로젝트는 설치 PC의 OpenSSH config·agent·키를 활용하고 신뢰된 host-key 검사를 유지해야 하므로 ssh2 자격정보 모델을 교체하지 않음 |
| SFTP 파일 전송 | 원격 개발 워크플로의 배포/아티팩트 이동에 도움이 될 수 있음 | 원격 파일 편집 도구와 같은 경로·권한 경계를 설계하고 파일 크기·부분 전송·감사 규칙을 검토한 뒤 별도 기능으로 평가 |

원본의 README는 역할·호스트 그룹 정책과 제한을 설명하고, [SECURITY 문서](https://github.com/tufantunc/ssh-mcp/blob/5c5b8476492cda568fca779b307ff8a2ca0bbbb7/SECURITY.md)는 위험 명령 분류가 일반적인 쓰기, alias/function/PATH 상태를 완전하게 판별하지 못할 수 있다고 경고합니다. 세션 관리자는 로그인 후 셸 초기화 명령을 넣지만, 현재 postLogin의 예상 프롬프트 기반 추가 로그인 절차를 대체하지 않습니다. HTTP 엔드포인트도 기존 인증된 MCP·브라우저 화면 설계를 대체하지 않아 선택적으로만 참고했습니다.

회전 소스는 활성 파일 100 MiB, 번호 보관본 최대 10개를 사용합니다. hash를 켠 경우 `loadLastHash`는 활성 파일의 끝부분에서만 마지막 해시를 읽습니다. 검토한 파일에서는 보관본 전체의 체인 연결을 기동 시 검증하는 로직을 찾지 못했습니다. Shell MCP는 오래된 구간을 자동 삭제하지 않고 보관 구간 전부를 부팅·CLI 검증에 포함합니다. 이는 원본 기능 복사가 아니라 보존·검증 범위를 확장한 적응입니다.

실제 화면·Copilot 클라이언트 연결, 외부 SSH 대상, TLS 배포는 이 조사에서 검증하지 않았습니다. 차기 후보와 반복 적용 절차는 [업스트림 마이그레이션 계획](UPSTREAM_MIGRATION.md), v0.5 구현 근거는 [검증 기록](V05_STATUS.md)을 참조하세요.

> 설계 단계의 조사 기록입니다. 이후 구현에서 이식한 범위는 [원본 고지](../THIRD_PARTY_NOTICES.md), 현재 구현 결과는 [구현 상태](IMPLEMENTATION_STATUS.md)를 참조하세요. 원본 두 프로젝트 자체를 빌드·실행한 것은 아닙니다.

조사일: 2026-10-21. GitHub 연결 도구로 기본 브랜치·커밋·파일을 읽고, 웹으로 VS Code·MCP·OpenSSH 공식 문서를 확인했습니다. 로컬 workspace는 시작 시 비어 있었습니다. 코드 그래프 도구는 이 세션에 제공되지 않아 그래프 generation·coverage 확인은 NOT RUN이며, 아래의 직접 소스 확인 범위로 근거를 제한합니다.

## 기준 리비전

| 저장소 | 기본 브랜치 | 확인 커밋 | 커밋 시각 UTC |
| --- | --- | --- | --- |
| Eugeny/tabby | master | `467ce8ebfa467fb88cf6d154c9a5891e3d3647f0` | 2026-10-06 21:17:08 |
| thuanpham582002/tabby-mcp-server | main | `5c08e2751dffd3b6fe3180f0c80fe5a7fde287df` | 2026-10-08 10:32:06 |

GitHub의 저장소 갱신 시각과 커밋 시각은 다릅니다. 위 값은 조사에서 확인한 커밋 식별자이며 최신 릴리스 번호를 의미하지 않습니다. 초기 주요 파일은 기본 브랜치에서 읽었고, 이후 확인한 브랜치 커밋이 위 리비전입니다. 구현 시에는 위 커밋으로 입력을 고정하고 다시 검사해야 합니다.

## Tabby에서 확인한 범위

- [`tabby-ssh/package.json`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/package.json): Angular와 Tabby 패키지에 대한 peer dependency를 확인했습니다.
- [`session/ssh.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/ssh.ts): 처음 220줄에서 russh import, SSHSession, 인증 방식·agent·DI 관련 타입과 초기화 일부를 확인했습니다. 파일 전체 감사를 하지 않았습니다.
- [`session/shell.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/shell.ts): 별도 셸 클래스, SSH 참조, 출력 구독 후 초기 cwd 적용, EOF/close 처리를 확인했습니다.
- [`session/shellChannel.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/shellChannel.ts): 터미널 타입 기본값과 PTY 요청 분리를 확인했습니다.
- [`services/sshMultiplexer.service.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/services/sshMultiplexer.service.ts): 프로필 기준 연결 보관과 종료 시 제거를 확인했습니다. 그 키를 새 서버의 사용자 격리 기준으로 그대로 사용하지 않습니다.
- [`session/authMethodSelection.ts`](https://github.com/Eugeny/tabby/blob/467ce8ebfa467fb88cf6d154c9a5891e3d3647f0/tabby-ssh/src/session/authMethodSelection.ts): 순수 인증 계획 선택 로직을 확인했습니다. OpenSSH 기반 첫 버전에서는 직접 인증 구현에 필요하지 않아 이식 대상에서 보류합니다.

**도출한 설계 판단:** 연결과 셸의 수명을 분리하되, B의 OpenSSH 동작 재사용을 우선해 UI·DI·russh 코어 전체 포팅은 하지 않습니다. 이것은 새 프로젝트의 선택이며 원본이 OpenSSH CLI로 동작한다는 주장이 아닙니다.

## tabby-mcp-server에서 확인한 범위

- [`README.md`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/README.md): 실행 중인 Tabby 플러그인, 도구 목록, SSE 엔드포인트와 기본 loopback 설정을 확인했습니다.
- [`package.json`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/package.json): 패키지 버전 1.1.0, MCP SDK 1.8.0과 Tabby/Angular peer dependency를 확인했습니다.
- [`services/mcpService.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/services/mcpService.ts): SSEServerTransport, `/sse`, `/messages`, 별도 HTTP 도구 경로와 loopback 기본값을 확인했습니다. 확인한 서비스 파일에서는 인증 미들웨어를 확인하지 못했으며, 전체 제품에 인증이 전혀 없다는 exhaustive claim은 하지 않습니다.
- [`terminal/exec-command-tool.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/tools/terminal/exec-command-tool.ts): 처음 330줄에서 Tabby 탭 입력, 현재 명령 추적, 시작 전 Ctrl+C, 서브셸 래핑, 버퍼 polling, 표식 기반 종료 판별과 자동 재시도 경로를 확인했습니다. 이 구현으로 지속되는 cd/export를 보장할 수 없습니다.
- [`tools/shell-strategy.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/tools/shell-strategy.ts): 셸별 보조 전략이 존재함을 확인했습니다. 확인한 exec 도구와 실제로 연결되는 전체 call graph를 검증한 것은 아닙니다.
- [`services/commandOutputStorage.service.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/services/commandOutputStorage.service.ts): 결과 ID·메타데이터·메모리 Map·페이지 조회 구조를 확인했습니다.
- [`terminal/get-command-output-tool.ts`](https://github.com/thuanpham582002/tabby-mcp-server/blob/5c08e2751dffd3b6fe3180f0c80fe5a7fde287df/src/tools/terminal/get-command-output-tool.ts): outputId 기반 조회 도구를 확인했습니다.

**도출한 설계 판단:** 명령 결과 모델과 페이지 조회 구조를 활용하고, 실행·저장·인증·네트워크 전송은 원격 서버의 요구사항에 맞게 다시 만듭니다. 기존 서버를 단순히 0.0.0.0에 바인딩하는 것만으로 요구사항이 충족된다고 판단하지 않습니다.

## 이식 계획과 원본 고지

| 출처 | 활용 계획 | 첫 버전 범위 |
| --- | --- | --- |
| Tabby SSHSession / SSHShellSession | 연결과 셸의 객체·생명주기 구조 참고 | 설계 재사용 |
| Tabby shellChannel | 터미널 타입 순수 로직과 관련 타입의 선별 이식 | PTY 확장 시 이식 |
| Tabby SSHProfile 관련 필드 | 별칭·사용자·포트·cwd의 프로젝트 타입으로 적응 | 프로필 모델 설계 |
| tabby-mcp output store / output tool | 결과 레코드·페이지 조회의 타입과 순수 로직 적응 | 구현 시 이식 후보 |
| tabby-mcp exec tool | 도구 계약 참고, 실제 실행 알고리즘 교체 | 설계 재사용 |

원본을 활용한다는 이유로 불필요한 Electron·Angular 런타임을 함께 넣지 않습니다. 실제 코드 복사 시에는 출처 파일·리비전·적응 내역을 `THIRD_PARTY_NOTICES`에 기록하고 관련 고지를 보존합니다. 아직 해당 이식이나 의존성 설치를 수행하지 않았습니다.

## 공식 문서와 설계에 반영한 사항

- [VS Code MCP 서버 추가](https://code.visualstudio.com/docs/agent-customization/mcp-servers): URL 서버 연결과 실제 도구 호출을 통한 검증.
- [VS Code MCP 설정 레퍼런스](https://code.visualstudio.com/docs/agents/reference/mcp-configuration): portable `mcpServers`와 VS Code `servers` 형식 차이, 입력 변수 제약.
- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http): 프로토콜 세션 제거, 요청별 스트림과 취소. 제품의 SSH sessionId를 독립적으로 설계.
- [MCP 2025-11-25 전송](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): 실제 클라이언트 버전에 따른 이전 동작 지원은 별도 어댑터로 처리.
- [MCP HTTP 인증](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): 원격 HTTP 인증을 SSH 인증과 별도 설계.
- [OpenSSH ssh_config](https://man.openbsd.org/ssh_config), [ssh](https://man.openbsd.org/ssh), [sftp](https://man.openbsd.org/sftp): 기존 설정 활용, 전용 master 소켓, 키/agent, 엄격한 host key, 보조 파일 채널.

## 검증 한계

두 저장소를 빌드하거나 실행하지 않았습니다. 실제 SSH 접속, 네트워크 캡처, 터미널 상태 보존, Copilot 연결, OAuth 상호운용, 파일 충돌, 취소 동작은 확인하지 않았습니다. 이번 산출물은 조사 근거에 기반한 구현 설계이며 제품 수용 테스트 결과가 아닙니다.
