use crate::importing::{import, ImportSource, NormalizedImportResult};

#[tauri::command]
pub async fn import_collection(
    source: ImportSource,
    workspace_id: String,
) -> Result<NormalizedImportResult, String> {
    import(source, workspace_id).await
}
