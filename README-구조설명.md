# 스마트건설관리시스템 파일 구조

GitHub 저장소 최상단에 이 폴더의 모든 파일과 폴더를 그대로 업로드하세요.

- `index.html`: 전체 화면의 고정 골격
- `assets/js/app.js`: 화면·저장 기능 연결
- `assets/js/project-config.js`: 계약내역 기준 46개 소공정과 기본 일정
- `assets/js/schedule-engine.js`: 예정률·실제율·대공종·지연일 자동 계산
- `assets/js/photo-recovery.js`: 기존 사진 복구와 중복 방지
- `assets/css/legacy.css`: 기존 화면 기본 스타일
- `assets/css/app-structure.css`: 홈·달력·간트·가독성 개선 스타일
- `documents/`: 건축·구조 도면과 시방서
- `images/`: 조감도 원본

공정 항목이나 기본 일정을 바꿀 때는 우선 `assets/js/project-config.js`만 수정하고,
계산 방식은 `assets/js/schedule-engine.js`, 색상과 글자 크기는
`assets/css/app-structure.css`에서 수정하면 됩니다.
