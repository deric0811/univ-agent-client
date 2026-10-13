# FFmpeg sidecar binaries

이 디렉터리의 대용량 실행 파일은 Git에 커밋하지 않습니다 (루트 `.gitignore` 참고).
빌드/실행 전에 대상 플랫폼에 맞는 파일을 아래 이름으로 배치하세요.

```
src-tauri/binaries/
├── univ-ffmpeg-x86_64-pc-windows-msvc.exe
├── univ-ffmpeg-x86_64-unknown-linux-gnu
└── (선택) univ-ffmpeg-aarch64-apple-darwin
```

## 규칙

- Tauri v2는 `tauri.conf.json`의 `bundle.externalBin: ["binaries/univ-ffmpeg"]` 항목을
  읽고 현재 타깃 트리플에 맞는 파일을 자동으로 찾습니다. 따라서 파일명은 반드시
  `univ-ffmpeg-<rust-target-triple>` 형식이어야 합니다 (Windows는 `.exe` 접미사).
- `ffprobe`는 사용하지 않으므로 번들에 포함하지 않습니다. 미디어 재생시간 확인은
  `univ-ffmpeg -hide_banner -i <file>` stderr 파싱으로 처리합니다.
- Linux/macOS 빌드에서는 실행 권한이 필요합니다: `chmod +x univ-ffmpeg-*`.
