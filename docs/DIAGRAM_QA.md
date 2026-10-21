# 구조도 검증 기록

구조도는 제안 아키텍처를 표현한 문서 산출물이며, 실행 중인 MCP 시스템을 관측한 그림이 아닙니다.

```text
diagram_type: architecture
output: /home/sra235/2026/shell-mcp/docs/architecture.html
specification_sha256: 5abded38b12acdaec369bc7094979b0df75e1003cf7b7a25491a8a2f59eedf0a
artifact_sha256: 15fe06ad36f09fe9c84ae1360dd0018a4d3756f9f38ca459d5d84b48d4b48070
validation: 9/9 showcase, 0 errors, 0 warnings
browser_evidence: passed
visual_review: passed
correction_rounds: 2
```

- [생성 검증 기록](architecture-delivery.json): 정확한 입력/HTML 해시와 산출물 검사. 입력 3,973 bytes, HTML 807,747 bytes.
- [자동 브라우저 검사](architecture.visual-check.json): Chrome에서 READ/Still 상태의 1440×900, 1600×1000, 1920×1080, 2048×1320 화면을 측정. 모두 가로·세로 넘침 없음, 가독성 및 뷰어 메뉴 검사 통과.
- [화면 모음](architecture.visual-check.html): 1440×900와 2048×1320의 밝은/어두운 테마 네 장.

시각 검토는 자동 기록과 별도로 생성 화면을 이미지 도구로 열어 수행했습니다. 한국어 표시, 주 경로, 서버 경계, 라벨 겹침, 연결선, 하단 카드와 큰 화면의 배치를 확인했습니다. 자동 브라우저 기록의 `visualReview: pending`은 도구가 시각 품질을 판정하지 않는다는 뜻이며 그대로 보존했습니다.

구조도 본문은 한국어입니다. Archify의 고정 뷰어 메뉴 및 HTML 언어 설정은 영어를 사용합니다. 스킬 설치 버전은 변경하지 않았습니다.

이 기록은 MCP 서버 빌드, Copilot 호환성, SSH 세션 유지, 인증·권한, 원격 파일 수정, 시간 초과와 취소 동작의 실행 증거가 아닙니다. 제품 검증은 [상세 설계의 수용 시나리오](DESIGN.md#15-수용-시나리오와-현재-검증-상태)에 모두 NOT RUN으로 남겼습니다.
