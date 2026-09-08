# financial-judge

브라우저에서 종목코드 1~10개를 입력하거나 Excel/CSV/TXT 목록을 불러와 OpenDART 기준 재무건전성을 분석하는 Cloudflare Worker 앱입니다.

## 구조

- `public/`: 브라우저 UI
- `src/index.js`: API + 정적 파일 제공
- `wrangler.jsonc`: Worker/정적 자산 설정
- `package.json`: Wrangler 및 파서 의존성

## Cloudflare Git 연동

Cloudflare Workers Builds에서 이 repository를 연결하고 Deploy command는:

`npx wrangler deploy`

Build command는 비워 둡니다.

## Secret

Cloudflare Worker의 Secret에 다음 값을 등록합니다.

`DART_API_KEY`

DART 인증키는 GitHub에 저장하지 않습니다.

## 로컬 목록

분석 목록은 브라우저 `localStorage`에 저장합니다.
Excel/CSV/TXT 파일 자체는 서버로 업로드하지 않고 브라우저에서 종목코드만 읽습니다.

## 판정

- 매출액 증가: 최근년도 > 전년도
- 순이익: 최근 2개년 모두 음수면 불량
- 영업CF > 0
- 투자CF < 0
- 재무CF < 0
- 이자보상배율 >= 1.0
- 대주주 지분율 >= 20.0

현재 대주주 지분율은 DART 최대주주 현황 API에서 기말 지분율이 가장 큰 단일 주주의 값을 사용합니다. 
