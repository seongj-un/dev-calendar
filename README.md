# dev-calendar

개발자용 캘린더 datebook입니다. 학사일정을 PDF, 캘린더(.ics), 엑셀, 한글, 나이스 API에서 가져와 개인 일정과 함께 봅니다. 서버 없이 브라우저에서만 동작하고, 데이터는 브라우저 localStorage에 저장합니다.

## 개발

Node 22.13 이상이 필요합니다.

```sh
npm ci
npm run dev      # 개발 서버
npm test         # 단위 테스트 (vitest, 워커 1개)
npm run lint     # ESLint + Prettier 검사
npm run build    # 타입 검사 후 dist/ 생성
```

SheetJS는 npm 레지스트리 버전이 오래되어 cdn.sheetjs.com 배포판(0.20.3)을 `vendor/`에 두고 설치합니다.

## 구조

- `src/model`: 일정 데이터 모델과 날짜 계산
- `src/store`: localStorage 저장소, JSON 백업, 가져오기 묶음 삭제
- `src/import`: 학사일정 가져오기 파서 (PDF, ICS, 엑셀, HWPX, HWP, 나이스). 가져오기를 열 때 동적 import로 불러옵니다.
- `tests/fixtures`: 파서 테스트용 샘플 파일

## 배포

main에 push하면 GitHub Actions가 테스트와 빌드 후 GitHub Pages에 배포합니다.
