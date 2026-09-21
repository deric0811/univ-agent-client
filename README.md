# 강의 학습 도우미 — M2 · M3 · M4

Tauri v2 + Rust + SvelteKit(Svelte 5) + TypeScript 기반 데스크톱 앱입니다.

## 실행

- 최신 stable Rust (검증 툴체인: 1.98.1), Node.js 22.12 이상, pnpm
- OS별 [Tauri 개발 전제 조건](https://v2.tauri.app/start/prerequisites/)
- 시스템 PATH에서 실행 가능한 `ffmpeg`

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

일반 브라우저의 `pnpm dev`만으로는 네이티브 파일 대화상자와 Rust IPC를 사용할 수 없습니다.

## 분석 흐름

1. **새 강의 분석**에서 네이티브 대화상자로 강의 영상과 PDF를 각각 선택합니다. 강의 제목을 입력할 수 있으며, 비워 두면 영상 파일명을 사용합니다.
2. **분석 시작** → `extract_audio_ffmpeg`: 앱 캐시에 UUID 이름의 16kHz/모노/64kbps MP3를 생성합니다.
3. `upload_job`: MP3와 PDF를 Rust에서 비동기 스트리밍 multipart(`audio`, `pdf`)로 전송합니다. 영상 원본은 전송하지 않습니다.
4. `invoke('get_job_status', { jobId })`로 받은 JSON의 작업 상태와 `waiting_count`를 표시합니다. 이전 상태 요청이 끝난 뒤 2초 후에 다시 조회하므로 요청이 겹치지 않습니다.
5. `COMPLETED`이면 `invoke('get_job_result', { jobId })`로 결과 마크다운을 가져와 `save_study_project`로 자동 저장합니다. 저장에 성공하면 즉시 새 프로젝트의 비디오/요약 뷰어로 전환합니다.
6. `FAILED`, HTTP 오류, 잘못된 응답, 네트워크 오류는 화면에 표시하고 중단합니다. 로컬 저장 실패 시 결과를 유지하고 **로컬 저장 다시 시도** 버튼을 제공합니다.

저장 위치는 Tauri의 `app_data_dir()/projects/{로컬 UUID}/`이며, `meta.json`에는 강의 제목, 서버 작업 ID, 원본 파일 경로, 분석 시각이 기록되고 `summary.md`에는 결과 원문이 저장됩니다. 서버의 작업 ID는 로컬 폴더 이름으로 직접 사용하지 않습니다.

분석 중에도 서재 탭을 둘러볼 수 있으며, 탭 전환은 진행 중인 분석을 중단하지 않습니다. 페이지 자체가 종료되면 폴링 타이머와 IPC 응답 대기를 중단하고 늦게 도착한 응답/오류는 무시합니다. 이미 실행된 Rust 명령이나 서버 작업 자체는 취소하지 않으며, 화면 종료 후에는 다음 파이프라인 단계로 진행하지 않습니다. GET 요청 제한 시간은 Rust에서 30초로 적용하고, 업로드 전체 제한 시간은 30분입니다.

## M3 — 로컬 서재

- **내 강의 서재**에서 저장된 강의를 최신 생성일 순으로 확인하고 열 수 있습니다. 새로고침으로 외부에서 변경된 저장 파일도 다시 조회합니다.
- `list_study_projects`는 `projects/`의 각 `meta.json`을 읽어 JSON 배열 문자열을 반환합니다. 처음 실행해 폴더가 없으면 빈 배열을 반환합니다.
- `load_study_project`는 `{ meta, markdown }` JSON 문자열을 반환합니다. 메타데이터의 M2 필드도 그대로 보존합니다.
- 제목이 없는 기존 프로젝트는 영상 파일명 → 생성일 → 프로젝트 ID 순으로 대체 제목을 표시합니다. 생성일이 없는 경우 UI에 정보 없음으로 표시합니다.
- 손상되거나 읽을 수 없는 개별 메타데이터는 목록에서 건너뛰고 Rust 로그에 원인을 남깁니다. 불러오기 실패(예: `summary.md` 없음)는 UI에 표시합니다. 디렉터리 이동 ID와 프로젝트/요약 파일의 심볼릭 링크는 조회 시 거부합니다.

## M4 — 비디오/요약 동기화 뷰어

- 데스크톱에서 좌우 50:50으로 영상과 렌더링된 마크다운을 표시하며, 좁은 창에서는 세로로 배치합니다.
- `[03:25]`는 205초, `[01:20:15]`는 4815초로 변환됩니다. 강조된 시간 버튼을 클릭하면 원본 영상의 `currentTime`을 바꾸고 `play()`를 호출합니다. 재생 위치에 따라 해당 시간 버튼이 강조됩니다.
- 영상 메타데이터가 아직 로드되지 않았다면 마지막 클릭 시점을 보관했다가 로드 후 이동합니다. 재생 거부, 영상 길이를 초과한 시간, 원본 파일/코덱 오류를 UI로 안내합니다.
- 플레이어는 `convertFileSrc(video_path)`와 Tauri asset protocol을 사용합니다. `tauri`의 `protocol-asset` 기능을 켜서 로컬 비디오의 Range 요청을 지원합니다.
- **비디오를 서재로 복사하거나 변환하지 않습니다.** 원본 파일을 옮기거나 삭제하면 영상은 재생되지 않지만 저장된 요약은 읽을 수 있습니다. MP4/MKV 등 실제 재생 가능 여부는 컨테이너와 코덱에 따라 다르며, Linux WebKitGTK에서는 필요한 GStreamer 코덱이 설치되어 있어야 합니다.

요청한 설정대로 `assetProtocol.scope`는 `["**"]`로 넓게 허용되어 있습니다. 이 범위는 로컬 파일 접근 범위가 크므로 신뢰할 수 없는 콘텐츠를 WebView에서 실행해서는 안 됩니다. 뷰어는 `marked`로 파싱한 뒤 DOMPurify의 제한된 태그/속성 목록으로 정화하고, 이미지·동영상·스크립트·임의 버튼 삽입을 차단합니다. 타임스탬프 버튼은 정화 후 텍스트 노드에만 생성합니다. 외부 HTTP(S) 링크는 시스템 브라우저로 열며, 코드 블록/인라인 코드/링크 내부는 타임스탬프로 치환하지 않습니다.

## API / CORS

API 주소: `https://univ-agent.h2omol.com`

- `POST /api/v1/jobs`: Rust `upload_job` 커맨드가 스트리밍 업로드를 수행합니다.
- `GET /api/v1/jobs/{job_id}` 및 `/result`: Rust `get_job_status` / `get_job_result` 커맨드가 조회합니다.
- 모든 원격 API 요청은 Rust `reqwest`에서 처리하며, 프론트엔드에서는 Tauri IPC만 사용합니다. WebView의 브라우저 `fetch`를 사용하지 않으므로 Linux WebKitGTK의 CORS 제한을 받지 않으며, 이 앱의 API 통신을 위한 Origin 허용 설정도 필요하지 않습니다. TLS/네트워크 오류와 HTTP 실패 응답은 Rust에서 에러 문자열로 전달합니다.

파일 선택 권한은 기존 `src-tauri/capabilities/default.json`의 `dialog:default`를 사용합니다. 외부 링크 열기는 기존 `opener:default` 권한을 사용합니다.

## 검증

```sh
pnpm check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
```

프론트엔드 테스트는 기존 M2 IPC/폴링뿐 아니라 서재 응답 검증, 타임스탬프 계산, 마크다운 보안 처리, Svelte 화면의 제목 저장·완료 후 자동 전환·저장 재시도·영상 시크를 확인합니다. Rust 테스트는 서재 스캔/구버전 호환/파일 오류/경로 검증과 기존 업로드 및 조회 기능을 검증합니다. UI 테스트의 IPC와 비디오 재생은 모킹합니다. 자동 테스트는 운영 API에 파일을 업로드하지 않으며, 실제 WebKitGTK의 코덱/Range 재생과 운영 서버 연동은 Tauri 앱에서 별도로 확인해야 합니다.
