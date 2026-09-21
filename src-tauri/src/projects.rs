use std::{collections::BTreeMap, fs, io::ErrorKind, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize)]
pub struct StudyProjectMeta {
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub video_path: String,
    // Preserve M2 fields (job_id, pdf_path, timestamps, schema_version, etc.).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct StudyProject {
    pub meta: StudyProjectMeta,
    pub markdown: String,
}

pub fn validate_project_id(project_id: &str) -> Result<(), String> {
    // A single directory name on both Unix and Windows, with no traversal.
    if project_id.trim().is_empty()
        || project_id.contains(['/', '\\', ':', '\0'])
        || project_id.ends_with(['.', ' '])
    {
        return Err(
            "Invalid project_id: expected a single non-empty directory name without '/', '\\', ':', NUL, or trailing dots/spaces"
                .to_string(),
        );
    }
    Ok(())
}

fn read_project_file(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to inspect project file '{}': {error}",
            path.display()
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "Project file is not a regular file: '{}'",
            path.display()
        ));
    }
    fs::read_to_string(path)
        .map_err(|error| format!("Failed to read project file '{}': {error}", path.display()))
}

fn read_metadata(project_dir: &Path, project_id: &str) -> Result<StudyProjectMeta, String> {
    let path = project_dir.join("meta.json");
    let contents = read_project_file(&path)?;
    let mut meta: StudyProjectMeta = serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid project metadata '{}': {error}", path.display()))?;
    // The directory is authoritative; stale/untrusted metadata cannot redirect a load.
    meta.project_id = project_id.to_string();
    if meta.title.trim().is_empty() {
        meta.title = meta
            .video_path
            .rsplit(['/', '\\'])
            .find(|part| !part.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if meta.created_at.trim().is_empty() {
                    project_id.to_string()
                } else {
                    meta.created_at.clone()
                }
            });
    }
    Ok(meta)
}

pub fn list_projects(projects_dir: &Path) -> Result<Vec<StudyProjectMeta>, String> {
    let entries = match fs::read_dir(projects_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Failed to scan the project library '{}': {error}",
                projects_dir.display()
            ));
        }
    };
    let mut projects = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Failed to read a project directory: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect '{}': {error}", entry.path().display()))?;
        // Do not follow a directory symlink outside the project's storage area.
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(project_id) = name.to_str() else {
            continue;
        };
        if validate_project_id(project_id).is_err() {
            continue;
        }
        match read_metadata(&entry.path(), project_id) {
            Ok(meta) => projects.push(meta),
            // A partial/corrupt project must not make the entire library unusable.
            Err(error) => eprintln!("Skipping study project '{project_id}': {error}"),
        }
    }
    // M2 writes UTC ISO-8601 dates. Missing legacy dates sort last.
    projects.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.project_id.cmp(&b.project_id))
    });
    Ok(projects)
}

pub fn load_project(projects_dir: &Path, project_id: &str) -> Result<StudyProject, String> {
    validate_project_id(project_id)?;
    let project_dir = projects_dir.join(project_id);
    let metadata = fs::symlink_metadata(&project_dir).map_err(|error| {
        format!(
            "Failed to inspect project '{}': {error}",
            project_dir.display()
        )
    })?;
    if !metadata.file_type().is_dir() {
        return Err(format!(
            "Project is not a regular directory: '{}'",
            project_dir.display()
        ));
    }
    Ok(StudyProject {
        meta: read_metadata(&project_dir, project_id)?,
        markdown: read_project_file(&project_dir.join("summary.md"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct TestLibrary(PathBuf);

    impl TestLibrary {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("univ-library-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn project(&self, id: &str, meta: Value) -> PathBuf {
            let dir = self.0.join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("meta.json"), serde_json::to_string(&meta).unwrap()).unwrap();
            fs::write(dir.join("summary.md"), "# 강의 요약\n\n[03:25] 핵심 개념\n").unwrap();
            dir
        }
    }

    impl Drop for TestLibrary {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_library_is_empty() {
        let library = TestLibrary::new();
        assert!(list_projects(&library.0.join("not-created"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn lists_newest_first_and_supports_legacy_titles() {
        let library = TestLibrary::new();
        library.project(
            "old",
            json!({"video_path": "/videos/강의 1.mp4", "created_at": "2026-01-01T00:00:00Z"}),
        );
        library.project("new", json!({"title": "자료구조", "created_at": "2026-02-01T00:00:00Z", "video_path": "/videos/2.mp4"}));
        library.project("windows", json!({"video_path": "C:\\Videos\\Lecture.mkv"}));
        let projects = list_projects(&library.0).unwrap();
        assert_eq!(projects[0].title, "자료구조");
        assert_eq!(projects[1].title, "강의 1.mp4");
        assert_eq!(projects[2].title, "Lecture.mkv");
    }

    #[test]
    fn falls_back_to_creation_date_or_directory_name() {
        let library = TestLibrary::new();
        library.project(
            "dated",
            json!({"title": " ", "created_at": "2026-02-01T00:00:00Z"}),
        );
        library.project("unknown", json!({}));
        assert_eq!(
            load_project(&library.0, "dated").unwrap().meta.title,
            "2026-02-01T00:00:00Z"
        );
        assert_eq!(
            load_project(&library.0, "unknown").unwrap().meta.title,
            "unknown"
        );
    }

    #[test]
    fn loads_original_markdown_and_preserves_metadata() {
        let library = TestLibrary::new();
        library.project("actual-id", json!({"project_id": "../other", "video_path": "/video.mp4", "job_id": "job-123", "pdf_path": "/notes.pdf"}));
        let project = load_project(&library.0, "actual-id").unwrap();
        assert_eq!(project.meta.project_id, "actual-id");
        assert_eq!(project.meta.extra["job_id"], "job-123");
        assert_eq!(project.markdown, "# 강의 요약\n\n[03:25] 핵심 개념\n");
        let value = serde_json::to_value(project).unwrap();
        assert_eq!(value["meta"]["pdf_path"], "/notes.pdf");
    }

    #[test]
    fn skips_corrupt_metadata_and_non_project_entries() {
        let library = TestLibrary::new();
        library.project("good", json!({"title": "Good"}));
        let bad = library.project("bad", json!({}));
        fs::write(bad.join("meta.json"), "not JSON").unwrap();
        fs::create_dir_all(library.0.join("partial")).unwrap();
        fs::write(library.0.join("unrelated.txt"), "ignore").unwrap();
        let projects = list_projects(&library.0).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].project_id, "good");
        assert!(load_project(&library.0, "bad")
            .unwrap_err()
            .contains("Invalid project metadata"));
    }

    #[test]
    fn reports_missing_summary_and_rejects_path_traversal() {
        let library = TestLibrary::new();
        let dir = library.project("partial", json!({}));
        fs::remove_file(dir.join("summary.md")).unwrap();
        assert!(load_project(&library.0, "partial")
            .unwrap_err()
            .contains("summary.md"));
        for id in ["../outside", "/tmp/outside", "..\\outside", "", ".."] {
            assert!(load_project(&library.0, id).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_project_or_summary_symlinks() {
        use std::os::unix::fs::symlink;
        let library = TestLibrary::new();
        let external = TestLibrary::new();
        let external_dir = external.project("outside", json!({}));
        symlink(&external_dir, library.0.join("linked")).unwrap();
        assert!(list_projects(&library.0).unwrap().is_empty());
        assert!(load_project(&library.0, "linked").is_err());
        let dir = library.project("local", json!({}));
        fs::remove_file(dir.join("summary.md")).unwrap();
        symlink(external_dir.join("summary.md"), dir.join("summary.md")).unwrap();
        assert!(load_project(&library.0, "local").is_err());
    }
}
