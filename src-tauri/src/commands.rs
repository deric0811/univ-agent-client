use std::{fs, path::Path, time::Duration};

use crate::projects::{self, validate_project_id};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const JOBS_URL: &str = "https://univ-agent.h2omol.com/api/v1/jobs";
const LOGIN_URL: &str = "https://univ-agent.h2omol.com/api/v1/auth/login";

pub struct AuthState(pub std::sync::Mutex<Option<String>>);

#[derive(Serialize)]
struct LoginRequest<'a> {
    username: &'a str,
    password: &'a str,
}

#[derive(Deserialize)]
struct LoginResponse {
    access_token: String,
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

    let response = reqwest::Client::new()
        .post(LOGIN_URL)
        .json(&LoginRequest {
            username: &username,
            password: &password,
        })
        .send()
        .await
        .map_err(|error| format!("로그인 서버에 연결하지 못했습니다: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("로그인 응답을 읽지 못했습니다: {error}"))?;

    if !status.is_success() {
        return if status == reqwest::StatusCode::UNAUTHORIZED {
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

#[tauri::command]
pub async fn upload_job(
    state: State<'_, AuthState>,
    audio_path: String,
    pdf_path: String,
) -> Result<String, String> {
    let token = access_token(&state)?;
    let audio = upload_file_part(&audio_path, "audio/mpeg").await?;
    let pdf = upload_file_part(&pdf_path, "application/pdf").await?;
    let form = Form::new().part("audio", audio).part("pdf", pdf);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(|error| format!("Failed to initialize the upload client: {error}"))?;
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
    Ok(body)
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

    let metadata_path = project_dir.join("meta.json");
    fs::write(&metadata_path, metadata_json).map_err(|error| {
        format!(
            "Failed to write project metadata '{}': {error}",
            metadata_path.display()
        )
    })?;

    let summary_path = project_dir.join("summary.md");
    fs::write(&summary_path, markdown_content).map_err(|error| {
        format!(
            "Failed to write the project summary '{}': {error}",
            summary_path.display()
        )
    })?;

    Ok(project_dir_string)
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

#[cfg(test)]
mod tests {
    use super::{job_query_url, upload_file_part, validate_project_id, Form, JOBS_URL};
    use std::{fs, path::PathBuf};
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
