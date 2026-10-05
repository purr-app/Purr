use crate::importing::{import, ImportSource, ImportTarget, NormalizedImportResult};

#[tauri::command]
pub async fn import_collection(
    source: ImportSource,
    workspace_id: String,
    target: Option<ImportTarget>,
    import_id: String,
) -> Result<NormalizedImportResult, String> {
    import(source, workspace_id, target.unwrap_or_default(), import_id).await
}
