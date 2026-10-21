# v0.7 원격 파일 목록 검증

v0.7은 기존 `list_files`를 확장해 원격 workspace 안의 이름순 디렉터리 목록과 기본 메타데이터를 제공합니다. 각 항목에는 type, 일반 파일에 한한 sizeBytes, modifiedAt(epoch milliseconds), permissions(octal)이 포함됩니다. 내용 바이트는 읽지 않으며 MCP 모델 문맥으로 보내지 않습니다.

목록은 한 페이지 100개입니다. helper는 최대 10,000개 이름 또는 이름 데이터 8 MiB까지만 모으며 어느 한도에 닿으면 `incomplete=true`와 `limitations`를 설정합니다. 이때 반환된 앞부분을 전체 목록으로 취급하면 안 됩니다. `snapshot=false`는 페이지 사이 파일시스템 변경을 잠그거나 스냅샷하지 않는다는 의미입니다. 항목 metadata는 `lstat`으로 링크 자체만 봅니다. symlink는 이름과 링크 자체의 권한/수정 시각만 표시하고 target, target 크기는 읽지 않습니다.

업스트림 `tufantunc/ssh-mcp`의 bounded `sftp-list`와 OpenSSH `sftp ls -l`에서 사용성을 참고했습니다. 실제 코드는 복사하지 않았습니다. 원격 경로는 등록 workspace 안으로 고정하고, 기존 SSH helper를 사용하며, 다운로드/업로드는 이 변경에 포함하지 않았습니다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| `npm run check` | PASS, 38개 unit·격리 OpenSSH·MCP·login·browser 시험 |
| 목록 메타데이터 | PASS: 일반 파일 크기·권한·수정시각, directory type, symlink lstat 확인 |
| 경로 경계 | PASS: `../` 및 symlink 경유 경로 거부, 파일 경로를 디렉터리 목록으로 사용 시 명시 거부 |
| 대형 목록 | PASS: 10,005개 fixture에서 10,000개 상한, 100개 cursor page와 `incomplete/entry_limit` 확인 |
| `npm run smoke` | PASS: 빌드된 서버 health, 인증된 MCP 발견 및 tool call, 20 tools |
| 실제 사용자 Copilot/VS Code, 공개 HTTPS·외부 IdP | NOT RUN |
| 121초 soak | NOT RUN |

검증은 같은 호스트의 임시 OpenSSH 서버와 fixture 디렉터리에서 실행했습니다. 실제 별도 C 장비와 사용자 Copilot은 확인하지 않았습니다. 10,000개를 넘거나 이름 데이터 8 MiB를 넘는 디렉터리는 부분 결과만 보이며, 외부에서 동시에 바뀌는 파일시스템과 원자적 스냅샷 보장은 없습니다.
