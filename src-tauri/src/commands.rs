use std::{
    fs,
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::projects::{self, validate_project_id};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{Command, CommandChild, CommandEvent},
    ShellExt,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const JOBS_URL: &str = "https://univ-agent.h2omol.com/api/v1/jobs";
const UPLOAD_CHUNK_URL: &str = "https://univ-agent.h2omol.com/api/v1/upload/chunk";
const LOGIN_URL: &str = "https://univ-agent.h2omol.com/api/v1/auth/login";
const MODELS_URL: &str = "https://univ-agent.h2omol.com/api/v1/models";
const SERVER_DOWN_MESSAGE: &str = "서버가 점검 중이거나 꺼져 있습니다. 개발자에게 문의하세요.";
const SCHOOL_DISPLAY_NAME: &str = "고려대 학우님";
const SCHOOL_LOGIN_URL: &str = "https://univ-agent.h2omol.com/api/v1/auth/login-school-key";

/// Cloudflare 100MB 요청 제한을 안전하게 통과하는 청크 크기(20MB).
const AUDIO_CHUNK_SIZE_BYTES: u64 = 20 * 1024 * 1024;
/// 청크별 최대 시도 횟수(최초 1회 + 재시도 2회).
const AUDIO_CHUNK_MAX_ATTEMPTS: usize = 3;
const UPLOAD_CONNECT_TIMEOUT_SECS: u64 = 30;
const UPLOAD_TIMEOUT_SECS: u64 = 30 * 60;
const AUDIO_UPLOAD_PROGRESS_EVENT: &str = "audio-upload-progress";

pub struct AuthState(pub std::sync::Mutex<Option<String>>);

/// A running FFmpeg merge that can be cancelled from the UI.
pub struct MergeProcess {
    pub child: CommandChild,
    /// The output file being written, so an aborted merge can clean it up.
    pub output_path: PathBuf,
}

/// Shared merge slot: at most one FFmpeg process may run at a time.
#[derive(Default)]
pub struct MergeState {
    process: Option<MergeProcess>,
    cancelled: bool,
}

/// Thread-safe handle to the currently running merge process, if any.
pub struct MergeProcessState(pub Arc<Mutex<MergeState>>);

impl Default for MergeProcessState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(MergeState::default())))
    }
}

/// 한 단계(스트림 복사 또는 폴백 인코딩) 실행 결과 분류.
#[derive(Debug)]
enum StageOutcome {
    Success,
    Failed(String),
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeStage {
    StreamCopy,
    Fallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeAction {
    Finish,
    Fallback,
    Abort,
}

#[derive(Debug, PartialEq, Eq)]
enum StageClaimError {
    Cancelled,
    SpawnFailed(String),
    Unavailable,
}

impl MergeProcessState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, MergeState>, String> {
        self.0
            .lock()
            .map_err(|_| "영상 합치기 상태를 확인하지 못했습니다.".to_string())
    }

    /// 새 병합 작업을 위해 취소 플래그를 초기화하고 슬롯이 비어 있는지 확인한다.
    fn begin_merge(&self) -> Result<(), String> {
        let mut guard = self.lock()?;
        if guard.process.is_some() {
            return Err("이미 영상 합치기 작업이 진행 중입니다.".to_string());
        }
        guard.cancelled = false;
        Ok(())
    }

    /// 취소 요청 여부를 확인한다. 락이 깨졌다면 안전하게 취소로 간주한다.
    fn is_cancelled(&self) -> bool {
        self.0.lock().map(|guard| guard.cancelled).unwrap_or(true)
    }

    /// 취소를 기록하고 실행 중인 자식 프로세스를 즉시 종료한다.
    fn request_cancel(&self) -> Result<(), String> {
        let process = {
            let mut guard = self.lock()?;
            guard.cancelled = true;
            guard.process.take()
        };
        if let Some(process) = process {
            // Best-effort: the process may already have exited on its own.
            if process.child.kill().is_ok() {
                // Only remove the output when the process was actually still alive,
                // so a freshly-completed file is never deleted by a late cancel.
                let _ = fs::remove_file(&process.output_path);
            }
        }
        Ok(())
    }

    /// 취소되지 않았을 때만 자식 프로세스를 슬롯에 등록하고 이벤트 수신기를 돌려준다.
    ///
    /// 스폰과 슬롯 교체를 같은 락 안에서 수행하므로, 1단계 종료 직후 도착한 취소가
    /// 2단계 프로세스를 놓치는 경쟁 상태가 발생하지 않는다.
    fn claim_slot<F>(
        &self,
        output_path: &Path,
        spawn: F,
    ) -> Result<tauri::async_runtime::Receiver<CommandEvent>, StageClaimError>
    where
        F: FnOnce() -> Result<
            (tauri::async_runtime::Receiver<CommandEvent>, CommandChild),
            tauri_plugin_shell::Error,
        >,
    {
        let mut guard = self.0.lock().map_err(|_| StageClaimError::Unavailable)?;
        if guard.cancelled {
            return Err(StageClaimError::Cancelled);
        }
        let (events, child) = spawn()
            .map_err(|error| StageClaimError::SpawnFailed(format!("FFmpeg 실행 실패: {error}")))?;
        guard.process = Some(MergeProcess {
            child,
            output_path: output_path.to_path_buf(),
        });
        Ok(events)
    }

    /// 작업이 끝난 슬롯을 정리하고 취소 여부를 반환한다.
    fn release_slot(&self, output_path: &Path) -> Result<bool, String> {
        let mut guard = self.lock()?;
        if guard.cancelled {
            return Ok(true);
        }
        if let Some(process) = guard.process.as_ref() {
            if process.output_path == output_path {
                guard.process = None;
            }
        }
        Ok(false)
    }
}

#[derive(Serialize)]
struct LoginRequest<'a> {
    username: &'a str,
    password: &'a str,
}

#[derive(Deserialize)]
struct LoginResponse {
    access_token: String,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Serialize)]
struct SchoolKeyLoginRequest<'a> {
    school_api_key: &'a str,
}

/// 서버가 꺼져 있을 때 무한 대기하지 않도록 타임아웃이 있는 로그인용 클라이언트.
fn login_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Failed to initialize the login client: {error}"))
}

fn is_server_down(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 502..=504)
}

#[tauri::command]
pub async fn login(
    state: State<'_, AuthState>,
    username: String,
    password: String,
) -> Result<String, String> {
    let username = username.trim().to_owned();
    if username.is_empty() || password.is_empty() {
        return Err("아이디와 비밀번호를 모두 입력해 주세요.".to_string());
    }

    let response = login_client()?
        .post(LOGIN_URL)
        .json(&LoginRequest {
            username: &username,
            password: &password,
        })
        .send()
        .await
        .map_err(|_| SERVER_DOWN_MESSAGE.to_string())?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("로그인 응답을 읽지 못했습니다: {error}"))?;

    if !status.is_success() {
        return if is_server_down(status) {
            Err(SERVER_DOWN_MESSAGE.to_string())
        } else if status == reqwest::StatusCode::UNAUTHORIZED {
            Err("아이디 또는 비밀번호가 올바르지 않습니다.".to_string())
        } else {
            Err(format!("로그인에 실패했습니다 (HTTP {status}): {body}"))
        };
    }

    let login: LoginResponse = serde_json::from_str(&body)
        .map_err(|error| format!("로그인 응답 형식이 올바르지 않습니다: {error}"))?;
    if login.access_token.trim().is_empty() {
        return Err("로그인 응답에 액세스 토큰이 없습니다.".to_string());
    }
    *state
        .0
        .lock()
        .map_err(|_| "인증 상태를 확인하지 못했습니다.".to_string())? = Some(login.access_token);
    Ok(username)
}

#[tauri::command]
pub async fn login_school_key(
    state: State<'_, AuthState>,
    school_api_key: String,
) -> Result<String, String> {
    let school_api_key = school_api_key.trim().to_owned();
    if school_api_key.is_empty() {
        return Err("학교 AI API 키를 입력해 주세요.".to_string());
    }

    let response = login_client()?
        .post(SCHOOL_LOGIN_URL)
        .json(&SchoolKeyLoginRequest {
            school_api_key: &school_api_key,
        })
        .send()
        .await
        .map_err(|_| SERVER_DOWN_MESSAGE.to_string())?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("학교 AI 로그인 응답을 읽지 못했습니다: {error}"))?;

    if !status.is_success() {
        return if is_server_down(status) {
            Err(SERVER_DOWN_MESSAGE.to_string())
        } else if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
        {
            Err("유효하지 않은 학교 AI API 키입니다.".to_string())
        } else {
            Err(format!(
                "학교 AI 로그인에 실패했습니다 (HTTP {status}): {body}"
            ))
        };
    }

    let login: LoginResponse = serde_json::from_str(&body)
        .map_err(|error| format!("로그인 응답 형식이 올바르지 않습니다: {error}"))?;
    if login.access_token.trim().is_empty() {
        return Err("로그인 응답에 액세스 토큰이 없습니다.".to_string());
    }
    *state
        .0
        .lock()
        .map_err(|_| "인증 상태를 확인하지 못했습니다.".to_string())? = Some(login.access_token);
    // 학교 API 키(BYOK) 세션은 서버가 준 식별자와 무관하게 표시 이름을 고정한다.
    let _ = login.username;
    Ok(SCHOOL_DISPLAY_NAME.to_string())
}

#[tauri::command]
pub fn logout(state: State<'_, AuthState>) -> Result<(), String> {
    *state
        .0
        .lock()
        .map_err(|_| "인증 상태를 확인하지 못했습니다.".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn is_authenticated(state: State<'_, AuthState>) -> Result<bool, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "인증 상태를 확인하지 못했습니다.".to_string())?
        .is_some())
}

fn access_token(state: &State<'_, AuthState>) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "인증 상태를 확인하지 못했습니다.".to_string())?
        .clone()
        .ok_or_else(|| "로그인이 필요합니다.".to_string())
}

// Extract audio from the bundled FFmpeg sidecar without depending on a
// system-installed ffmpeg. The sidecar runs asynchronously so the UI thread
// never blocks while the audio is being encoded.
#[tauri::command]
pub async fn extract_audio_ffmpeg(app: AppHandle, video_path: String) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("캐시 디렉터리 접근 실패: {error}"))?;
    fs::create_dir_all(&cache_dir).map_err(|error| format!("캐시 디렉터리 생성 실패: {error}"))?;

    let output_path = cache_dir.join(format!("{}.mp3", Uuid::new_v4()));
    let output_path_string = output_path.to_string_lossy().to_string();

    // The sidecar identifier is the bare binary name, not a path: Tauri
    // resolves "univ-ffmpeg" to the target-specific binary in bundle.externalBin.
    let sidecar_command = app
        .shell()
        .sidecar("univ-ffmpeg")
        .map_err(|error| format!("FFmpeg 사이드카 초기화 실패: {error}"))?;

    let output = sidecar_command
        .args(["-y", "-i", video_path.as_str()])
        .args([
            "-vn", "-ar", "16000", "-ac", "1", "-b:a", "64k", "-f", "mp3",
        ])
        .arg(&output_path)
        .output()
        .await
        .map_err(|error| format!("FFmpeg 실행 실패: {error}"))?;

    if !output.status.success() {
        // Do not leave a partial audio file behind after an encoding failure.
        let _ = fs::remove_file(&output_path);
        return Err(format!(
            "FFmpeg 변환 오류: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(output_path_string)
}

/// 여러 영상에서 16 kHz 모노 WAV 오디오를 추출한 뒤, 재인코딩 없이 하나로 결합한다.
///
/// 비디오를 디코딩/인코딩하지 않고 오디오 트랙만 뽑아 copy 결합하므로
/// 모바일 저전력 CPU에서도 수초 안에 끝난다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedAudio {
    pub audio_path: String,
    /// 입력 영상 순서대로의 재생시간(초). 요약 타임스탬프를 개별 영상으로 매핑할 때 쓴다.
    pub video_durations: Vec<f64>,
}

#[tauri::command]
pub async fn extract_and_merge_audio_from_videos(
    app: AppHandle,
    video_paths: Vec<PathBuf>,
    output_audio_path: PathBuf,
) -> Result<ExtractedAudio, String> {
    if video_paths.is_empty() {
        return Err("오디오를 추출할 영상이 없습니다.".to_string());
    }
    if let Some(parent) = output_audio_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("오디오 저장 폴더 생성 실패: {error}"))?;
    }

    let temp_dir = std::env::temp_dir().join(format!("univ-audio-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("임시 오디오 폴더 생성 실패: {error}"))?;
    // 성공/실패와 무관하게 추출된 임시 WAV를 모두 정리한다.
    let _temp_guard = TempDirGuard::new(temp_dir.clone());

    let mut extracted = Vec::with_capacity(video_paths.len());
    let mut video_durations = Vec::with_capacity(video_paths.len());
    for (index, video_path) in video_paths.iter().enumerate() {
        let audio_path = temp_dir.join(format!("part_{index:03}.wav"));
        video_durations.push(extract_audio_to_wav(&app, video_path, &audio_path).await?);
        extracted.push(audio_path);
    }

    let list_path = temp_dir.join("audio_concat.txt");
    let list_paths: Vec<String> = extracted
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    fs::write(
        &list_path,
        build_concat_list_content(&list_paths, cfg!(windows)),
    )
    .map_err(|error| format!("임시 오디오 목록 생성 실패: {error}"))?;

    // 모든 임시 WAV는 같은 16 kHz mono PCM이므로 concat demuxer로 즉시 복사 결합한다.
    let output = app
        .shell()
        .sidecar("univ-ffmpeg")
        .map_err(|error| format!("FFmpeg 사이드카 초기화 실패: {error}"))?
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(&list_path)
        .arg("-c")
        .arg("copy")
        .arg("-y")
        .arg(&output_audio_path)
        .output()
        .await
        .map_err(|error| format!("오디오 병합 실행 실패: {error}"))?;

    if !output.status.success() {
        let _ = fs::remove_file(&output_audio_path);
        return Err(format!(
            "오디오 병합 오류: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(ExtractedAudio {
        audio_path: output_audio_path.to_string_lossy().to_string(),
        video_durations,
    })
}

async fn extract_audio_to_wav(
    app: &AppHandle,
    video_path: &Path,
    output_path: &Path,
) -> Result<f64, String> {
    let output = app
        .shell()
        .sidecar("univ-ffmpeg")
        .map_err(|error| format!("FFmpeg 사이드카 초기화 실패: {error}"))?
        .arg("-y")
        .arg("-i")
        .arg(video_path)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .args(["-f", "wav"])
        .arg(output_path)
        .output()
        .await
        .map_err(|error| format!("오디오 추출 실행 실패: {error}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        let _ = fs::remove_file(output_path);
        return Err(format!(
            "FFmpeg 오디오 추출 오류 ({}): {stderr}",
            video_path.display()
        ));
    }

    // 추출 stderr의 입력 메타데이터에서 영상별 재생시간을 함께 확보한다.
    parse_ffmpeg_duration(&stderr).ok_or_else(|| {
        format!(
            "영상 재생시간을 확인하지 못했습니다: {}",
            video_path.display()
        )
    })
}

/// 임시 오디오 디렉터리를 통째로 지우는 RAII 가드.
struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioUploadProgress {
    chunk_index: usize,
    total_chunks: usize,
    message: String,
}

fn emit_audio_upload_progress(app: &AppHandle, chunk_index: usize, total_chunks: usize) {
    let _ = app.emit(
        AUDIO_UPLOAD_PROGRESS_EVENT,
        AudioUploadProgress {
            chunk_index,
            total_chunks,
            message: format!(
                "오디오 전송 중... ({}/{} 조각)",
                chunk_index + 1,
                total_chunks
            ),
        },
    );
}

/// 20MB 기준 총 조각 수를 계산한다(빈 파일은 0조각).
fn audio_chunk_count(file_size: u64) -> usize {
    if file_size == 0 {
        0
    } else {
        file_size.div_ceil(AUDIO_CHUNK_SIZE_BYTES) as usize
    }
}

/// WAV를 20MB 조각으로 나눠 순차 업로드하고 (upload_id, total_chunks)를 돌려준다.
/// 각 조각은 네트워크/5xx 오류 시 최대 2회 재시도한다.
async fn upload_audio_in_chunks(
    app: &AppHandle,
    client: &reqwest::Client,
    token: &str,
    audio_path: &str,
) -> Result<(String, usize), String> {
    let path = Path::new(audio_path);
    let file_metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("오디오 파일을 확인하지 못했습니다: {error}"))?;
    if !file_metadata.is_file() {
        return Err(format!("오디오 경로가 파일이 아닙니다: {audio_path}"));
    }
    let file_size = file_metadata.len();
    if file_size == 0 {
        return Err("오디오 파일이 비어 있습니다.".to_string());
    }
    let total_chunks = audio_chunk_count(file_size);
    let upload_id = Uuid::new_v4().to_string();

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("오디오 파일을 열지 못했습니다: {error}"))?;

    for index in 0..total_chunks {
        emit_audio_upload_progress(app, index, total_chunks);
        let offset = index as u64 * AUDIO_CHUNK_SIZE_BYTES;
        let length = (file_size - offset).min(AUDIO_CHUNK_SIZE_BYTES) as usize;
        let mut buffer = vec![0u8; length];
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(|error| format!("오디오 조각을 읽지 못했습니다: {error}"))?;
        file.read_exact(&mut buffer)
            .await
            .map_err(|error| format!("오디오 조각을 읽지 못했습니다: {error}"))?;
        upload_chunk_with_retry(client, token, &upload_id, index, total_chunks, buffer).await?;
    }

    Ok((upload_id, total_chunks))
}

async fn upload_chunk_with_retry(
    client: &reqwest::Client,
    token: &str,
    upload_id: &str,
    chunk_index: usize,
    total_chunks: usize,
    buffer: Vec<u8>,
) -> Result<(), String> {
    let mut last_error = String::new();
    for attempt in 1..=AUDIO_CHUNK_MAX_ATTEMPTS {
        let part = Part::bytes(buffer.clone())
            .file_name(format!("chunk_{chunk_index}.part"))
            .mime_str("application/octet-stream")
            .map_err(|error| format!("청크 준비 실패: {error}"))?;
        let form = Form::new()
            .text("upload_id", upload_id.to_string())
            .text("chunk_index", chunk_index.to_string())
            .text("total_chunks", total_chunks.to_string())
            .part("chunk_file", part);

        match client
            .post(UPLOAD_CHUNK_URL)
            .bearer_auth(token)
            .multipart(form)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    return Ok(());
                }
                let body = response.text().await.unwrap_or_default();
                last_error =
                    format!("오디오 조각 {chunk_index} 업로드 실패 (HTTP {status}): {body}");
                // 4xx는 재시도해도 의미가 없으므로 즉시 중단한다.
                if !status.is_server_error() {
                    return Err(last_error);
                }
            }
            Err(error) => {
                last_error = format!("오디오 조각 {chunk_index} 전송 오류: {error}");
            }
        }

        if attempt < AUDIO_CHUNK_MAX_ATTEMPTS {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    Err(last_error)
}

/// 업로드 응답의 `job_id` / `queue_position`을 snake_case·camelCase 양쪽으로 보강한다.
/// JSON 파싱에 실패하면 원본 문자열을 그대로 돌려준다.
fn normalize_job_response(body: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.to_string();
    };
    if let Some(object) = value.as_object_mut() {
        if let Some(job_id) = object
            .get("job_id")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
        {
            object
                .entry("jobId")
                .or_insert(serde_json::Value::String(job_id));
        } else if let Some(job_id) = object
            .get("jobId")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
        {
            object
                .entry("job_id")
                .or_insert(serde_json::Value::String(job_id));
        }
        if let Some(position) = object.get("queue_position").cloned() {
            object.entry("queuePosition").or_insert(position);
        } else if let Some(position) = object.get("queuePosition").cloned() {
            object.entry("queue_position").or_insert(position);
        }
    }
    serde_json::to_string(&value).unwrap_or_else(|_| body.to_string())
}

#[tauri::command]
pub async fn upload_job(
    app: AppHandle,
    state: State<'_, AuthState>,
    audio_path: Option<String>,
    pdf_path: String,
    metadata_json: String,
    model: Option<String>,
    analysis_mode: Option<String>,
) -> Result<String, String> {
    let token = access_token(&state)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(UPLOAD_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(UPLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("Failed to initialize the upload client: {error}"))?;

    // 1) 오디오가 있는 경우에만 20MB 조각으로 나눠 전송한다.
    //    문서 전용 분석(PDF만)이면 오디오 업로드를 통째로 건너뛴다.
    let audio_upload = match audio_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => {
            let (upload_id, total_chunks) =
                upload_audio_in_chunks(&app, &client, &token, path).await?;
            Some((upload_id, total_chunks))
        }
        None => None,
    };

    // 2) PDF/메타데이터와 함께 분석 작업을 트리거한다.
    let pdf = upload_file_part(&pdf_path, "application/pdf").await?;
    let mut form = Form::new().text("metadata", metadata_json);
    if let Some((upload_id, total_chunks)) = audio_upload {
        form = form
            .text("upload_id", upload_id)
            .text("total_chunks", total_chunks.to_string());
    }
    if let Some(model) = model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        form = form.text("model", model.to_string());
    }
    if let Some(mode) = analysis_mode
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        form = form.text("analysis_mode", mode.to_string());
    }
    let form = form.part("pdf", pdf);

    let response = client
        .post(JOBS_URL)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Failed to upload the study files: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read the upload response (HTTP {status}): {error}"))?;
    if !status.is_success() {
        return Err(format!("Study upload failed (HTTP {status}): {body}"));
    }

    // Preserve the server JSON verbatim; the frontend validates the job response.
    Ok(normalize_job_response(&body))
}

/// 현재 계정에서 사용할 수 있는 LLM 모델 목록(JSON)을 가져온다.
#[tauri::command]
pub async fn list_models(state: State<'_, AuthState>) -> Result<String, String> {
    let token = access_token(&state)?;
    let url =
        reqwest::Url::parse(MODELS_URL).map_err(|error| format!("Invalid models URL: {error}"))?;
    get_job_json(url, &token).await
}

#[tauri::command]
pub async fn get_job_status(state: State<'_, AuthState>, job_id: String) -> Result<String, String> {
    let token = access_token(&state)?;
    get_job_json(job_query_url(&job_id, false)?, &token).await
}

#[tauri::command]
pub async fn get_job_result(state: State<'_, AuthState>, job_id: String) -> Result<String, String> {
    let token = access_token(&state)?;
    get_job_json(job_query_url(&job_id, true)?, &token).await
}

fn job_query_url(job_id: &str, result: bool) -> Result<reqwest::Url, String> {
    if job_id.trim().is_empty() || matches!(job_id, "." | "..") {
        return Err("Invalid job_id: expected a non-empty job identifier".to_string());
    }

    let mut url = reqwest::Url::parse(JOBS_URL)
        .map_err(|error| format!("Failed to construct the jobs API URL: {error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|()| "The jobs API URL cannot contain path segments".to_string())?;
        // Encode the ID as one segment, not as a path, query, or fragment.
        segments.push(job_id);
        if result {
            segments.push("result");
        }
    }
    Ok(url)
}

async fn get_job_json(url: reqwest::Url, token: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Failed to initialize the job query client: {error}"))?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|error| format!("Failed to query the study job: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read the job response (HTTP {status}): {error}"))?;
    if !status.is_success() {
        return Err(format!("Study job query failed (HTTP {status}): {body}"));
    }

    // Return the original JSON string for frontend validation, as with upload_job.
    Ok(body)
}

async fn upload_file_part(file_path: &str, mime_type: &str) -> Result<Part, String> {
    let path = Path::new(file_path);
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid upload filename: '{file_path}'"))?
        .to_owned();
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("Failed to open upload file '{file_path}': {error}"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("Failed to inspect upload file '{file_path}': {error}"))?;
    if !metadata.is_file() {
        return Err(format!("Upload path is not a regular file: '{file_path}'"));
    }

    // ReaderStream reads bounded chunks instead of buffering the entire lecture.
    let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
    Part::stream_with_length(body, metadata.len())
        .file_name(filename)
        .mime_str(mime_type)
        .map_err(|error| format!("Failed to prepare upload file '{file_path}': {error}"))
}

#[tauri::command(async)]
pub fn save_study_project(
    app: AppHandle,
    project_id: String,
    metadata_json: String,
    markdown_content: String,
) -> Result<String, String> {
    validate_project_id(&project_id)?;

    let project_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve the app data directory: {error}"))?
        .join("projects")
        .join(&project_id);
    let project_dir_string = project_dir
        .to_str()
        .ok_or_else(|| "The project directory path is not valid UTF-8".to_string())?
        .to_owned();

    fs::create_dir_all(&project_dir).map_err(|error| {
        format!(
            "Failed to create the project directory '{}': {error}",
            project_dir.display()
        )
    })?;

    // summary.md를 먼저 쓴 뒤 meta.json을 마지막에 원자적으로 커밋한다.
    // 그래야 반쪽짜리 프로젝트가 서재 목록에 노출되지 않는다.
    let summary_path = project_dir.join("summary.md");
    write_atomic(&summary_path, &markdown_content)?;

    let metadata_path = project_dir.join("meta.json");
    write_atomic(&metadata_path, &metadata_json)?;

    Ok(project_dir_string)
}

/// 같은 디렉터리에 임시 파일을 쓴 뒤 rename해 원자적으로 교체한다.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("저장 경로가 올바르지 않습니다: {}", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("저장 파일 이름이 올바르지 않습니다: {}", path.display()))?;
    let temp_path = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    fs::write(&temp_path, contents).map_err(|error| {
        format!(
            "임시 파일을 쓰지 못했습니다 '{}': {error}",
            temp_path.display()
        )
    })?;
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "파일을 원자적으로 교체하지 못했습니다 '{}': {error}",
            path.display()
        )
    })
}

/// 분석 완료 후 남은 임시 오디오/병합 PDF를 정리한다.
/// 사용자 원본을 지우지 않도록 `merged_` 접두사 파일만 삭제한다.
#[tauri::command(async)]
pub fn cleanup_temp_files(paths: Vec<String>) -> Result<(), String> {
    for raw_path in paths {
        let path = Path::new(raw_path.trim());
        let is_merge_temp = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("merged_"))
            .unwrap_or(false);
        if is_merge_temp {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn list_study_projects(app: AppHandle) -> Result<String, String> {
    let projects_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve the app data directory: {error}"))?
        .join("projects");
    let library = projects::list_projects(&projects_dir)?;
    serde_json::to_string(&library)
        .map_err(|error| format!("Failed to serialize the project library: {error}"))
}

#[tauri::command(async)]
pub fn load_study_project(app: AppHandle, project_id: String) -> Result<String, String> {
    let projects_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve the app data directory: {error}"))?
        .join("projects");
    let project = projects::load_project(&projects_dir, &project_id)?;
    serde_json::to_string(&project)
        .map_err(|error| format!("Failed to serialize the study project: {error}"))
}

fn project_directory(app: &AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> {
    projects::validate_project_id(project_id)?;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve the app data directory: {error}"))?
        .join("projects")
        .join(project_id))
}

fn require_project_dir(dir: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(dir)
        .map_err(|error| format!("Failed to inspect project '{}': {error}", dir.display()))?;
    if !metadata.file_type().is_dir() {
        return Err(format!(
            "Project is not a regular directory: '{}'",
            dir.display()
        ));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn delete_study_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let project_dir = project_directory(&app, &project_id)?;
    // Never recurse into a directory symlink that points outside the library.
    require_project_dir(&project_dir)?;
    fs::remove_dir_all(&project_dir).map_err(|error| {
        format!(
            "Failed to delete project '{}': {error}",
            project_dir.display()
        )
    })
}

fn set_optional_meta_field(value: &mut serde_json::Value, key: &str, field: Option<String>) {
    let Some(field) = field else {
        return;
    };
    let field = field.trim().to_owned();
    if field.is_empty() {
        if let Some(object) = value.as_object_mut() {
            object.remove(key);
        }
    } else {
        value[key] = serde_json::Value::String(field);
    }
}

#[tauri::command(async)]
pub fn rename_study_project(
    app: AppHandle,
    project_id: String,
    new_title: String,
    course: Option<String>,
    chapter: Option<String>,
) -> Result<(), String> {
    let new_title = new_title.trim().to_owned();
    if new_title.is_empty() {
        return Err("새 제목을 입력해 주세요.".to_string());
    }

    let project_dir = project_directory(&app, &project_id)?;
    require_project_dir(&project_dir)?;
    let meta_path = project_dir.join("meta.json");
    let metadata = fs::symlink_metadata(&meta_path).map_err(|error| {
        format!(
            "Failed to inspect project metadata '{}': {error}",
            meta_path.display()
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "Project metadata is not a regular file: '{}'",
            meta_path.display()
        ));
    }

    let contents = fs::read_to_string(&meta_path).map_err(|error| {
        format!(
            "Failed to read project metadata '{}': {error}",
            meta_path.display()
        )
    })?;
    let mut value: serde_json::Value = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "Invalid project metadata '{}': {error}",
            meta_path.display()
        )
    })?;
    if !value.is_object() {
        return Err(format!(
            "Project metadata is not a JSON object: '{}'",
            meta_path.display()
        ));
    }
    value["title"] = serde_json::Value::String(new_title);
    set_optional_meta_field(&mut value, "course", course);
    set_optional_meta_field(&mut value, "chapter", chapter);
    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to serialize project metadata: {error}"))?;
    fs::write(&meta_path, pretty).map_err(|error| {
        format!(
            "Failed to write project metadata '{}': {error}",
            meta_path.display()
        )
    })
}

#[tauri::command(async)]
pub fn open_project_folder(app: AppHandle, project_id: String) -> Result<(), String> {
    let project_dir = project_directory(&app, &project_id)?;
    require_project_dir(&project_dir)?;
    let path = project_dir.as_path();

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(path.as_os_str())
        .spawn()
        .map_err(|error| format!("파일 탐색기를 열지 못했습니다: {error}"))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(path.as_os_str())
        .spawn()
        .map_err(|error| format!("파일 탐색기를 열지 못했습니다: {error}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(path.as_os_str())
        .spawn()
        .map_err(|error| format!("파일 탐색기를 열지 못했습니다: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn open_file_in_folder(file_path: String) -> Result<(), String> {
    let file_path = file_path.trim();
    if file_path.is_empty() {
        return Err("파일 경로를 지정해 주세요.".to_string());
    }
    let path = Path::new(file_path);

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg("/select,")
        .arg(path.as_os_str())
        .spawn()
        .map_err(|error| format!("파일 탐색기를 열지 못했습니다: {error}"))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(path.as_os_str())
        .spawn()
        .map_err(|error| format!("파일 탐색기를 열지 못했습니다: {error}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        std::process::Command::new("xdg-open")
            .arg(parent.as_os_str())
            .spawn()
            .map_err(|error| format!("파일 탐색기를 열지 못했습니다: {error}"))?;
    }

    Ok(())
}

const MERGE_PROGRESS_EVENT: &str = "video-merge-progress";
const STREAM_COPY_MESSAGE: &str = "초고속 스트림 병합 시도 중...";
const FALLBACK_MESSAGE: &str = "코덱/해상도 불일치 감지됨: 초고속 최적화 인코딩으로 전환 중...";
const CANCELLED_MESSAGE: &str = "영상 합치기 작업이 취소되었습니다.";
/// 컨테이너 타임스탬프 오차를 감안한 재생시간 허용 범위(초).
const DURATION_TOLERANCE_SECS: f64 = 1.5;
const DURATION_MISMATCH_MESSAGE: &str =
    "스트림 복사 결과의 재생시간이 예상과 달라 초고속 최적화 인코딩으로 전환합니다.";

#[derive(Clone, Serialize)]
struct MergeProgress {
    stage: &'static str,
    message: String,
    percent: f32,
}

fn emit_merge_progress(app: &AppHandle, stage: &'static str, message: &str, percent: f32) {
    // 이벤트 수신자가 없어도 병합 자체는 계속 진행한다.
    let _ = app.emit(
        MERGE_PROGRESS_EVENT,
        MergeProgress {
            stage,
            message: message.to_string(),
            percent,
        },
    );
}

/// stderr의 `time=` 진행률을 0.5초 또는 1% 단위로 스로틀링한다.
struct ProgressThrottle {
    last_percent: f32,
    last_emit: Instant,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last_percent: 0.0,
            last_emit: Instant::now(),
        }
    }

    fn should_emit(&mut self, percent: f32, now: Instant) -> bool {
        // FFmpeg 진행 시간은 단조 증가하므로 감소/동일 값은 무시한다.
        if percent <= self.last_percent {
            return false;
        }
        if now.duration_since(self.last_emit) >= Duration::from_millis(500)
            || percent - self.last_percent >= 1.0
        {
            self.last_percent = percent;
            self.last_emit = now;
            true
        } else {
            false
        }
    }
}

/// concat demuxer 목록에 넣을 경로를 `file '...'` 형식으로 안전하게 감싼다.
///
/// Windows 경로는 FFmpeg가 확실히 이해하는 `/` 구분자로 바꾸고, 작은따옴표는
/// 셸과 동일한 `'\''` 방식으로 이어 붙여 특수문자가 경로를 깨뜨리지 않게 한다.
fn escape_concat_path(path: &str, windows: bool) -> String {
    let normalized = if windows {
        path.replace('\\', "/")
    } else {
        path.to_string()
    };
    format!("file '{}'", normalized.replace('\'', "'\\''"))
}

fn build_concat_list_content(video_paths: &[String], windows: bool) -> String {
    let mut content = String::new();
    for path in video_paths {
        content.push_str(&escape_concat_path(path, windows));
        content.push('\n');
    }
    content
}

fn write_concat_list(list_path: &Path, video_paths: &[String]) -> Result<(), String> {
    let content = build_concat_list_content(video_paths, cfg!(windows));
    fs::write(list_path, content)
        .map_err(|error| format!("임시 병합 목록을 만들지 못했습니다: {error}"))
}

/// 임시 list.txt가 성공/실패/취소 어느 경로로 끝나도 삭제되도록 보장한다.
struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// 2단계 폴백용 경량 인코딩 필터. 720p 캔버스로 통일하고 44.1 kHz 스테레오로 맞춘다.
fn fallback_filter_description(video_count: usize) -> String {
    let mut filter_parts: Vec<String> = Vec::new();
    for index in 0..video_count {
        filter_parts.push(format!(
            "[{index}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v{index}]"
        ));
        filter_parts.push(format!(
            "[{index}:a]aformat=sample_rates=44100:channel_layouts=stereo[a{index}]"
        ));
    }
    let stream_pairs: String = (0..video_count)
        .map(|index| format!("[v{index}][a{index}]"))
        .collect();
    filter_parts.push(format!(
        "{stream_pairs}concat=n={video_count}:v=1:a=1[v][a]"
    ));
    filter_parts.join(";")
}

fn build_stream_copy_command(
    app: &AppHandle,
    list_path: &Path,
    output_path: &str,
) -> Result<Command, String> {
    let command = app
        .shell()
        .sidecar("univ-ffmpeg")
        .map_err(|error| format!("FFmpeg 사이드카 초기화 실패: {error}"))?;
    Ok(command
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        // 입력 PTS가 비어 있거나 어긋난 파일을 위해 타임스탬프를 보정한다.
        .arg("-fflags")
        .arg("+genpts")
        .arg("-i")
        .arg(list_path)
        .arg("-c")
        .arg("copy")
        // 음수 타임스탬프를 0 기준으로 정렬해 편집 리스트 간격을 줄인다.
        .arg("-avoid_negative_ts")
        .arg("make_zero")
        .arg("-y")
        .arg(output_path))
}

fn build_fallback_command(
    app: &AppHandle,
    video_paths: &[String],
    output_path: &str,
) -> Result<Command, String> {
    let mut command = app
        .shell()
        .sidecar("univ-ffmpeg")
        .map_err(|error| format!("FFmpeg 사이드카 초기화 실패: {error}"))?;
    for path in video_paths {
        command = command.arg("-i").arg(path.as_str());
    }
    Ok(command
        .arg("-filter_complex")
        .arg(fallback_filter_description(video_paths.len()))
        .args(["-map", "[v]", "-map", "[a]"])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "26"])
        .args(["-c:a", "aac", "-b:a", "128k", "-ar", "44100"])
        .args(["-pix_fmt", "yuv420p"])
        .arg("-y")
        .arg(output_path))
}

fn next_merge_action(stage: MergeStage, outcome: &StageOutcome) -> MergeAction {
    match outcome {
        StageOutcome::Success => MergeAction::Finish,
        StageOutcome::Cancelled => MergeAction::Abort,
        StageOutcome::Failed(_) if stage == MergeStage::StreamCopy => MergeAction::Fallback,
        StageOutcome::Failed(_) => MergeAction::Abort,
    }
}

fn outcome_error_message(outcome: StageOutcome) -> String {
    match outcome {
        StageOutcome::Cancelled => CANCELLED_MESSAGE.to_string(),
        StageOutcome::Failed(message) => message,
        StageOutcome::Success => "FFmpeg 영상 합치기에 실패했습니다.".to_string(),
    }
}

fn remove_incomplete_output(output_path: &Path) {
    let _ = fs::remove_file(output_path);
}

/// FFmpeg stderr에 포함된 `Duration: HH:MM:SS.cc`를 초 단위로 변환한다.
/// `Duration: N/A`나 형식이 다른 값은 None을 돌려준다.
fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    let marker = "Duration:";
    let start = stderr.find(marker)? + marker.len();
    let token: String = stderr[start..]
        .trim_start()
        .chars()
        .take_while(|character| !character.is_whitespace() && *character != ',')
        .collect();
    parse_duration_token(&token)
}

fn parse_duration_token(token: &str) -> Option<f64> {
    let mut parts = token.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// 1단계 결과물의 재생시간이 예상 총 재생시간과 허용 오차(1.5초)를 넘게
/// 차이 나면 절단 또는 팽창(A/V 싱크 파괴)으로 판정한다.
fn is_stream_copy_duration_mismatch(actual_duration: f64, expected_total_duration: f64) -> bool {
    (actual_duration - expected_total_duration).abs() > DURATION_TOLERANCE_SECS
}

/// FFmpeg 진행 라인의 `time=HH:MM:SS.cc`를 초 단위로 읽는다.
fn parse_progress_seconds(line: &str) -> Option<f64> {
    let marker = "time=";
    let start = line.find(marker)? + marker.len();
    let token: String = line[start..]
        .chars()
        .take_while(|character| !character.is_whitespace() && *character != ',')
        .collect();
    parse_duration_token(&token)
}

fn progress_percent(seconds: f64, expected_total_duration: f64) -> Option<f32> {
    if expected_total_duration <= 0.0 {
        return None;
    }
    Some(((seconds / expected_total_duration) * 100.0).clamp(0.0, 100.0) as f32)
}

fn emit_encoding_progress(app: &AppHandle, percent: f32) {
    let rounded = percent.round().clamp(0.0, 100.0) as i32;
    emit_merge_progress(
        app,
        "encoding",
        &format!("인코딩 병합 중... ({rounded}%)"),
        percent,
    );
}

/// 번들된 univ-ffmpeg만으로 파일의 재생시간을 읽는다. 출력을 지정하지 않으면
/// ffmpeg는 종료 코드 1로 끝나지만 Duration 정보는 stderr에 남는다.
async fn get_media_duration(app: &AppHandle, file_path: &Path) -> Result<f64, String> {
    let output = app
        .shell()
        .sidecar("univ-ffmpeg")
        .map_err(|error| format!("FFmpeg 사이드카 초기화 실패: {error}"))?
        .arg("-hide_banner")
        .arg("-i")
        .arg(file_path)
        .output()
        .await
        .map_err(|error| format!("재생시간 확인 실패: {error}"))?;

    parse_ffmpeg_duration(&String::from_utf8_lossy(&output.stderr))
        .ok_or_else(|| format!("재생시간을 확인하지 못했습니다: {}", file_path.display()))
}

async fn measure_total_duration(app: &AppHandle, video_paths: &[String]) -> Option<f64> {
    let mut total = 0.0;
    for path in video_paths {
        total += get_media_duration(app, Path::new(path)).await.ok()?;
    }
    Some(total)
}

/// 1단계가 exit 0으로 끝나도 결과물이 예상보다 짧으면 실패로 재분류한다.
async fn validate_stream_copy_output(
    app: &AppHandle,
    state: &MergeProcessState,
    output_path: &Path,
    expected_total_duration: Option<f64>,
) -> StageOutcome {
    if state.is_cancelled() {
        return StageOutcome::Cancelled;
    }
    let Some(expected) = expected_total_duration else {
        return StageOutcome::Success;
    };
    let Ok(actual) = get_media_duration(app, output_path).await else {
        // 결과물을 읽지 못하면 절단 여부를 판단할 수 없으므로 성공으로 유지한다.
        return StageOutcome::Success;
    };
    if state.is_cancelled() {
        return StageOutcome::Cancelled;
    }
    if is_stream_copy_duration_mismatch(actual, expected) {
        StageOutcome::Failed(DURATION_MISMATCH_MESSAGE.to_string())
    } else {
        StageOutcome::Success
    }
}

/// 한 단계(스트림 복사 또는 폴백 인코딩)를 실행하고 결과를 분류한다.
async fn run_merge_stage(
    app: &AppHandle,
    state: &MergeProcessState,
    command: Command,
    output_path: &Path,
    stage: MergeStage,
    expected_total_duration: Option<f64>,
) -> StageOutcome {
    let mut events = match state.claim_slot(output_path, || command.spawn()) {
        Ok(events) => events,
        Err(StageClaimError::Cancelled) => return StageOutcome::Cancelled,
        Err(StageClaimError::SpawnFailed(message)) => return StageOutcome::Failed(message),
        Err(StageClaimError::Unavailable) => {
            return StageOutcome::Failed("영상 합치기 상태를 확인하지 못했습니다.".to_string())
        }
    };

    let mut throttle = ProgressThrottle::new();
    let mut stderr = Vec::new();
    let mut exit_code: Option<i32> = None;
    let mut saw_termination = false;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stderr(line) => {
                stderr.extend_from_slice(&line);
                // 2단계 인코딩에서만 `time=` 진행률을 파싱해 스로틀링 후 전송한다.
                if stage == MergeStage::Fallback {
                    if let Some(expected) = expected_total_duration {
                        if let Some(seconds) =
                            parse_progress_seconds(&String::from_utf8_lossy(&line))
                        {
                            if let Some(percent) = progress_percent(seconds, expected) {
                                if throttle.should_emit(percent, Instant::now()) {
                                    emit_encoding_progress(app, percent);
                                }
                            }
                        }
                    }
                }
            }
            CommandEvent::Stdout(_) => {}
            CommandEvent::Error(message) => stderr.extend_from_slice(message.as_bytes()),
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                saw_termination = true;
            }
            _ => {}
        }
    }

    // 취소가 이미 슬롯을 가져갔거나 플래그를 세웠다면 성공/실패보다 취소가 우선한다.
    match state.release_slot(output_path) {
        Ok(true) => StageOutcome::Cancelled,
        Ok(false) if saw_termination && exit_code == Some(0) => StageOutcome::Success,
        Ok(false) => StageOutcome::Failed(if stderr.is_empty() {
            "FFmpeg 영상 합치기에 실패했습니다.".to_string()
        } else {
            format!(
                "FFmpeg 영상 합치기 오류: {}",
                String::from_utf8_lossy(&stderr)
            )
        }),
        Err(message) => StageOutcome::Failed(message),
    }
}

#[tauri::command]
pub async fn concat_videos_ffmpeg(
    app: AppHandle,
    state: State<'_, MergeProcessState>,
    video_paths: Vec<String>,
    output_path: String,
) -> Result<String, String> {
    let video_paths: Vec<String> = video_paths
        .into_iter()
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
        .collect();
    if video_paths.is_empty() {
        return Err("합칠 영상 파일이 한 개 이상 필요합니다.".to_string());
    }
    let output_path = output_path.trim();
    if output_path.is_empty() {
        return Err("저장할 출력 파일 경로를 지정해 주세요.".to_string());
    }

    // Only one merge may run at a time so the callbacks and state stay unambiguous.
    state.begin_merge()?;

    // 절단 검증을 위해 입력 파일들의 총 재생시간을 먼저 측정한다.
    let expected_total_duration = measure_total_duration(&app, &video_paths).await;
    if state.is_cancelled() {
        return Err(CANCELLED_MESSAGE.to_string());
    }

    let output_path_buf = PathBuf::from(output_path);
    let list_path = std::env::temp_dir().join(format!("univ-merge-{}.txt", Uuid::new_v4()));
    // 성공/실패/취소/패닉 어느 경우에도 list.txt가 남지 않도록 RAII로 정리한다.
    let _list_guard = TempFileGuard::new(list_path.clone());
    write_concat_list(&list_path, &video_paths)?;

    // 1단계: 인코딩 없는 스트림 복사.
    emit_merge_progress(&app, "stream-copy", STREAM_COPY_MESSAGE, 0.0);
    let stream_copy = build_stream_copy_command(&app, &list_path, output_path)?;
    let stage_outcome = run_merge_stage(
        &app,
        &state,
        stream_copy,
        &output_path_buf,
        MergeStage::StreamCopy,
        expected_total_duration,
    )
    .await;
    // exit code 0이어도 결과가 절단되었으면 실패로 재분류해 폴백을 트리거한다.
    let stage_outcome = match stage_outcome {
        StageOutcome::Success => {
            validate_stream_copy_output(&app, &state, &output_path_buf, expected_total_duration)
                .await
        }
        other => other,
    };

    match next_merge_action(MergeStage::StreamCopy, &stage_outcome) {
        MergeAction::Finish => Ok(output_path.to_string()),
        MergeAction::Abort => {
            remove_incomplete_output(&output_path_buf);
            Err(outcome_error_message(stage_outcome))
        }
        MergeAction::Fallback => {
            // 불완전한 1단계 출력은 지우고 초경량 인코딩으로 즉시 전환한다.
            remove_incomplete_output(&output_path_buf);
            if state.is_cancelled() {
                return Err(CANCELLED_MESSAGE.to_string());
            }
            emit_merge_progress(&app, "fallback", FALLBACK_MESSAGE, 0.0);

            let fallback = build_fallback_command(&app, &video_paths, output_path)?;
            let stage_outcome = run_merge_stage(
                &app,
                &state,
                fallback,
                &output_path_buf,
                MergeStage::Fallback,
                expected_total_duration,
            )
            .await;
            match next_merge_action(MergeStage::Fallback, &stage_outcome) {
                MergeAction::Finish => Ok(output_path.to_string()),
                _ => {
                    remove_incomplete_output(&output_path_buf);
                    Err(outcome_error_message(stage_outcome))
                }
            }
        }
    }
}

#[tauri::command]
pub fn cancel_merge_video(state: State<'_, MergeProcessState>) -> Result<(), String> {
    state.request_cancel()
}

#[cfg(test)]
mod tests {
    use super::{
        audio_chunk_count, build_concat_list_content, cleanup_temp_files, escape_concat_path,
        fallback_filter_description, is_stream_copy_duration_mismatch, job_query_url,
        next_merge_action, normalize_job_response, parse_ffmpeg_duration, parse_progress_seconds,
        progress_percent, upload_file_part, validate_project_id, write_atomic, Form, MergeAction,
        MergeProcessState, MergeStage, ProgressThrottle, StageClaimError, StageOutcome,
        TempDirGuard, TempFileGuard, AUDIO_CHUNK_SIZE_BYTES, JOBS_URL,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };
    use uuid::Uuid;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("univ-agent-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn merge_process_state_starts_idle() {
        let state = MergeProcessState::default();
        assert!(!state.is_cancelled());

        state.begin_merge().unwrap();

        assert!(!state.is_cancelled());
    }

    #[test]
    fn begin_merge_clears_a_previous_cancellation() {
        let state = MergeProcessState::default();
        state.begin_merge().unwrap();
        state.request_cancel().unwrap();
        assert!(state.is_cancelled());

        state.begin_merge().unwrap();

        assert!(!state.is_cancelled());
    }

    #[test]
    fn cancellation_during_stream_copy_aborts_instead_of_falling_back() {
        assert_eq!(
            next_merge_action(MergeStage::StreamCopy, &StageOutcome::Cancelled),
            MergeAction::Abort
        );
        assert_eq!(
            next_merge_action(MergeStage::Fallback, &StageOutcome::Cancelled),
            MergeAction::Abort
        );
        assert_eq!(
            next_merge_action(
                MergeStage::StreamCopy,
                &StageOutcome::Failed("mismatch".to_string())
            ),
            MergeAction::Fallback
        );
        assert_eq!(
            next_merge_action(
                MergeStage::Fallback,
                &StageOutcome::Failed("broken".to_string())
            ),
            MergeAction::Abort
        );
        assert_eq!(
            next_merge_action(MergeStage::StreamCopy, &StageOutcome::Success),
            MergeAction::Finish
        );
    }

    #[test]
    fn cancelled_slot_refuses_to_spawn_the_fallback_process() {
        let state = MergeProcessState::default();
        state.begin_merge().unwrap();
        state.request_cancel().unwrap();

        let result = state.claim_slot(Path::new("/tmp/merged.mp4"), || {
            panic!("a cancelled merge must never spawn another process")
        });

        assert!(matches!(result, Err(StageClaimError::Cancelled)));
    }

    #[test]
    fn temporary_concat_list_is_removed_on_drop() {
        let path = std::env::temp_dir().join(format!("univ-agent-list-{}.txt", Uuid::new_v4()));
        fs::write(&path, "file '/tmp/a.mp4'\n").unwrap();
        {
            let _guard = TempFileGuard::new(path.clone());
            assert!(path.exists());
        }
        assert!(!path.exists());
    }

    #[test]
    fn writes_files_atomically_without_leaving_temp_files() {
        let directory = TestDirectory::new();
        let target = directory.0.join("meta.json");
        fs::write(&target, "old").unwrap();

        write_atomic(&target, "new").unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        let leftovers = fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn cleanup_removes_only_merged_temp_files() {
        let directory = TestDirectory::new();
        let merged_audio = directory.0.join("merged_audio_1.wav");
        let merged_pdf = directory.0.join("merged_lecture_1.pdf");
        let original_pdf = directory.0.join("lecture.pdf");
        fs::write(&merged_audio, b"audio").unwrap();
        fs::write(&merged_pdf, b"merged").unwrap();
        fs::write(&original_pdf, b"original").unwrap();

        cleanup_temp_files(vec![
            merged_audio.to_string_lossy().to_string(),
            merged_pdf.to_string_lossy().to_string(),
            original_pdf.to_string_lossy().to_string(),
        ])
        .unwrap();

        assert!(!merged_audio.exists());
        assert!(!merged_pdf.exists());
        assert!(original_pdf.exists());
    }

    #[test]
    fn temporary_audio_directory_is_removed_on_drop() {
        let path = std::env::temp_dir().join(format!("univ-agent-audio-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("part_000.wav"), b"wav").unwrap();
        {
            let _guard = TempDirGuard::new(path.clone());
            assert!(path.join("part_000.wav").exists());
        }
        assert!(!path.exists());
    }

    #[test]
    fn computes_audio_chunk_count_for_cloudflare_limit() {
        assert_eq!(audio_chunk_count(0), 0);
        assert_eq!(audio_chunk_count(1), 1);
        assert_eq!(audio_chunk_count(AUDIO_CHUNK_SIZE_BYTES), 1);
        assert_eq!(audio_chunk_count(AUDIO_CHUNK_SIZE_BYTES + 1), 2);
        // 130MB WAV는 20MB 단위로 7조각이 된다.
        assert_eq!(audio_chunk_count(130 * 1024 * 1024), 7);
    }

    #[test]
    fn escapes_concat_list_paths_for_both_platforms() {
        assert_eq!(
            escape_concat_path("/videos/part one.mp4", false),
            "file '/videos/part one.mp4'"
        );
        assert_eq!(
            escape_concat_path("/videos/part's one.mp4", false),
            "file '/videos/part'\\''s one.mp4'"
        );
        assert_eq!(
            escape_concat_path(r"C:\videos\part one.mp4", true),
            "file 'C:/videos/part one.mp4'"
        );
        assert_eq!(
            escape_concat_path(r"C:\videos\it's.mp4", true),
            "file 'C:/videos/it'\\''s.mp4'"
        );
        // 드라이브 문자 + 공백 + 한글 + 작은따옴표가 섞인 Windows 경로
        assert_eq!(
            escape_concat_path(r"C:\강의 자료\1부 '개요'.mp4", true),
            "file 'C:/강의 자료/1부 '\\''개요'\\''.mp4'"
        );
    }

    #[test]
    fn parses_ffmpeg_duration_from_stderr() {
        assert_eq!(
            parse_ffmpeg_duration("  Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s"),
            Some(83.45)
        );
        assert_eq!(parse_ffmpeg_duration("Duration: 01:02:03.50"), Some(3723.5));
        assert_eq!(
            parse_ffmpeg_duration("Duration: 00:00:00.00, start: 0.000000"),
            Some(0.0)
        );
        assert_eq!(parse_ffmpeg_duration("Duration: 00:00:01.5"), Some(1.5));
    }

    #[test]
    fn rejects_missing_or_malformed_duration_lines() {
        assert_eq!(
            parse_ffmpeg_duration("Duration: N/A, start: 0.000000"),
            None
        );
        assert_eq!(parse_ffmpeg_duration("no duration metadata here"), None);
        assert_eq!(parse_ffmpeg_duration("Duration: 00:00"), None);
        assert_eq!(parse_ffmpeg_duration("Duration: 00:00:00:00"), None);
    }

    #[test]
    fn flags_truncated_or_bloated_stream_copy_output_for_fallback() {
        // 절단(예상보다 짧음)
        assert!(is_stream_copy_duration_mismatch(3.0, 6.0));
        assert!(is_stream_copy_duration_mismatch(3.4, 5.0));
        // 팽창(예상보다 김): 55분 12초 -> 1시간 6분
        assert!(is_stream_copy_duration_mismatch(
            66.0 * 60.0,
            55.0 * 60.0 + 12.0
        ));
        // 오차 허용 범위(1.5초) 안이면 정상으로 본다.
        assert!(!is_stream_copy_duration_mismatch(4.6, 6.0));
        assert!(!is_stream_copy_duration_mismatch(6.1, 6.0));
        assert!(!is_stream_copy_duration_mismatch(7.5, 6.0));
        // 허용 오차를 넘는 순간부터 실패로 판정한다.
        assert!(is_stream_copy_duration_mismatch(7.6, 6.0));
        assert!(is_stream_copy_duration_mismatch(4.4, 6.0));
    }

    #[test]
    fn bloated_duration_triggers_fallback_action() {
        let expected = 55.0 * 60.0 + 12.0;
        let actual = 66.0 * 60.0;
        let outcome = if is_stream_copy_duration_mismatch(actual, expected) {
            StageOutcome::Failed("bloated".to_string())
        } else {
            StageOutcome::Success
        };
        assert_eq!(
            next_merge_action(MergeStage::StreamCopy, &outcome),
            MergeAction::Fallback
        );

        let healthy_outcome = if is_stream_copy_duration_mismatch(6.0, 6.0) {
            StageOutcome::Failed("mismatch".to_string())
        } else {
            StageOutcome::Success
        };
        assert_eq!(
            next_merge_action(MergeStage::StreamCopy, &healthy_outcome),
            MergeAction::Finish
        );
    }

    #[test]
    fn parses_encoding_progress_time_from_stderr() {
        assert_eq!(
            parse_progress_seconds(
                "frame=  120 fps=30.0 q=28.0 size=  256kB time=00:00:04.05 bitrate= 517.6kbits/s"
            ),
            Some(4.05)
        );
        assert_eq!(
            parse_progress_seconds("time=01:02:03.50 bitrate= 1k"),
            Some(3723.5)
        );
        assert_eq!(parse_progress_seconds("time=N/A"), None);
        assert_eq!(parse_progress_seconds("frame=1 fps=0.0"), None);
    }

    #[test]
    fn computes_clamped_encoding_percent() {
        assert_eq!(progress_percent(30.0, 60.0), Some(50.0));
        assert_eq!(progress_percent(0.0, 60.0), Some(0.0));
        // 예상 길이를 넘어서도 100%로 고정한다.
        assert_eq!(progress_percent(120.0, 60.0), Some(100.0));
        assert_eq!(progress_percent(30.0, 0.0), None);
    }

    #[test]
    fn throttles_encoding_progress_events() {
        let base = Instant::now();
        let mut throttle = ProgressThrottle::new();

        // 1% 미만 + 0.5초 미만은 전송하지 않는다.
        assert!(!throttle.should_emit(0.4, base));
        // 1% 이상 증가하면 즉시 전송한다.
        assert!(throttle.should_emit(1.5, base));
        // 1% 미만 + 0.5초 미만은 전송하지 않는다.
        assert!(!throttle.should_emit(2.0, base + Duration::from_millis(100)));
        // 0.5초가 지나면 작은 증가도 전송한다.
        assert!(throttle.should_emit(2.6, base + Duration::from_millis(600)));
        // 감소/동일 값은 시간이 지나도 전송하지 않는다.
        assert!(!throttle.should_emit(2.6, base + Duration::from_secs(5)));
    }

    #[test]
    fn normalizes_upload_response_job_id_aliases() {
        let normalized =
            normalize_job_response(r#"{"job_id":"abc","status":"queued","queue_position":2}"#);
        let value: serde_json::Value = serde_json::from_str(&normalized).unwrap();
        assert_eq!(value["job_id"], "abc");
        assert_eq!(value["jobId"], "abc");
        assert_eq!(value["queue_position"], 2);
        assert_eq!(value["queuePosition"], 2);
    }

    #[test]
    fn leaves_non_json_upload_responses_untouched() {
        assert_eq!(
            normalize_job_response("<html>bad gateway</html>"),
            "<html>bad gateway</html>"
        );
    }

    #[test]
    fn builds_multiline_concat_list() {
        let video_paths = vec![
            "/videos/first.mp4".to_string(),
            "/videos/second.mp4".to_string(),
        ];
        assert_eq!(
            build_concat_list_content(&video_paths, false),
            "file '/videos/first.mp4'\nfile '/videos/second.mp4'\n"
        );
    }

    #[test]
    fn builds_lightweight_fallback_filter_graph() {
        assert_eq!(
            fallback_filter_description(2),
            r#"[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v0];[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v1];[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"#
        );
    }

    #[test]
    fn constructs_job_status_and_result_urls() {
        assert_eq!(
            job_query_url("lecture-job-1", false).unwrap().as_str(),
            format!("{JOBS_URL}/lecture-job-1")
        );
        assert_eq!(
            job_query_url("lecture-job-1", true).unwrap().as_str(),
            format!("{JOBS_URL}/lecture-job-1/result")
        );
    }

    #[test]
    fn encodes_job_ids_as_a_single_url_segment() {
        for result in [false, true] {
            let url = job_query_url("job/with spaces?#%", result).unwrap();
            let suffix = if result { "/result" } else { "" };
            assert_eq!(
                url.as_str(),
                format!("{JOBS_URL}/job%2Fwith%20spaces%3F%23%25{suffix}")
            );
            assert_eq!(url.host_str(), Some("univ-agent.h2omol.com"));
            assert_eq!(url.query(), None);
            assert_eq!(url.fragment(), None);
        }
    }

    #[test]
    fn rejects_empty_or_dot_segment_job_ids() {
        for job_id in ["", " ", ".", ".."] {
            assert!(job_query_url(job_id, false).is_err());
            assert!(job_query_url(job_id, true).is_err());
        }
    }

    #[test]
    fn prepares_streaming_multipart_with_a_known_length() {
        let directory = TestDirectory::new();
        let audio_path = directory.0.join("lecture audio.mp3");
        let pdf_path = directory.0.join("lecture notes.pdf");
        fs::write(&audio_path, b"test audio").unwrap();
        fs::write(&pdf_path, b"%PDF-test notes").unwrap();

        tauri::async_runtime::block_on(async {
            let audio = upload_file_part(audio_path.to_str().unwrap(), "audio/mpeg")
                .await
                .unwrap();
            let pdf = upload_file_part(pdf_path.to_str().unwrap(), "application/pdf")
                .await
                .unwrap();
            // Build only: tests never send study data to the production server.
            let request = reqwest::Client::new()
                .post(JOBS_URL)
                .multipart(Form::new().part("audio", audio).part("pdf", pdf))
                .build()
                .unwrap();
            assert!(request.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with("multipart/form-data; boundary="));
            assert!(
                request.headers()["content-length"]
                    .to_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
                    > 24
            );
            assert!(request.body().unwrap().as_bytes().is_none());
        });
    }

    #[test]
    fn rejects_missing_upload_files_before_sending() {
        let directory = TestDirectory::new();
        let audio_path = directory.0.join("audio.mp3");
        let pdf_path = directory.0.join("missing.pdf");
        fs::write(&audio_path, b"test audio").unwrap();
        let error = tauri::async_runtime::block_on(upload_file_part(
            pdf_path.to_str().unwrap(),
            "application/pdf",
        ))
        .unwrap_err();
        assert!(error.contains("Failed to open upload file"));
        assert!(error.contains("missing.pdf"));
    }

    #[test]
    fn rejects_directories_as_upload_files() {
        let directory = TestDirectory::new();
        let result = tauri::async_runtime::block_on(upload_file_part(
            directory.0.to_str().unwrap(),
            "application/pdf",
        ));
        assert!(result.is_err());
    }

    #[test]
    fn accepts_project_directory_names() {
        for project_id in [
            "lecture-01",
            "project_2",
            "lecture.v1",
            "강의 1",
            "550e8400-e29b-41d4-a716-446655440000",
        ] {
            assert!(validate_project_id(project_id).is_ok(), "{project_id:?}");
        }
    }

    #[test]
    fn rejects_project_ids_that_are_not_safe_directory_names() {
        for project_id in [
            "",
            " ",
            ".",
            "..",
            "../other",
            "..\\other",
            "/tmp/project",
            "C:\\project",
            "C:project",
            "project/child",
            "project\\child",
            "project/",
            "project\0",
            ".. ",
            "project.",
            "project ",
        ] {
            assert!(validate_project_id(project_id).is_err(), "{project_id:?}");
        }
    }
}

#[cfg(test)]
mod server_down_tests {
    use super::*;

    #[test]
    fn gateway_errors_are_treated_as_server_down() {
        for code in [502, 503, 504] {
            assert!(is_server_down(reqwest::StatusCode::from_u16(code).unwrap()));
        }
        assert!(!is_server_down(reqwest::StatusCode::UNAUTHORIZED));
        assert!(!is_server_down(reqwest::StatusCode::INTERNAL_SERVER_ERROR));
    }
}
