use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use std::fs;
use tauri_plugin_dialog::DialogExt;

use crate::content::{
    actor::ResponseContentState,
    contracts::{
        ByteRange, ContentInfo, ContentOperationResult, ContentWindow, FormatRequest,
        JsonQueryRequest, LinePage, ResponseContentRef, SearchPage, SearchQuery,
    },
    operations_state::ContentOperationState,
};

fn safe_file_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other => other,
        })
        .take(180)
        .collect();
    let cleaned = cleaned.trim_matches('.').trim();
    if cleaned.is_empty() {
        "response.bin".into()
    } else {
        cleaned.into()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSuggestion {
    file_name: String,
    media_type: String,
}

fn extension_of(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("bin")
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect()
}

#[tauri::command]
pub async fn save_response_body(
    app: tauri::AppHandle,
    body_base64: String,
    suggested_name: String,
    extension: String,
) -> Result<Option<String>, String> {
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|error| format!("Cannot decode the response: {error}"))?;
    let file_name = safe_file_name(&suggested_name);
    let extension: String = extension
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save response")
        .set_file_name(file_name);
    if !extension.is_empty() {
        dialog = dialog.add_filter("Response file", &[extension.as_str()]);
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    fs::write(&path, bytes).map_err(|error| format!("Cannot save {}: {error}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub async fn response_content_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResponseContentState>,
    reference: ResponseContentRef,
    suggestion: SaveSuggestion,
) -> Result<Option<String>, String> {
    let file_name = safe_file_name(&suggestion.file_name);
    let extension = extension_of(&file_name);
    let media_type: String = suggestion
        .media_type
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '+' | '.' | '-')
        })
        .take(80)
        .collect();
    let description = if media_type.is_empty() {
        "Response file"
    } else {
        &media_type
    };
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save response")
        .set_file_name(file_name);
    if !extension.is_empty() {
        dialog = dialog.add_filter(description, &[extension.as_str()]);
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    state
        .handle(&app)?
        .save_to_path(reference.id, &path)
        .await?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub async fn response_content_inspect(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResponseContentState>,
    reference: ResponseContentRef,
) -> Result<ContentInfo, String> {
    state.handle(&app)?.inspect(reference.id).await
}

#[tauri::command]
pub async fn response_content_read_range(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResponseContentState>,
    reference: ResponseContentRef,
    range: ByteRange,
    mode: String,
) -> Result<ContentWindow, String> {
    state
        .handle(&app)?
        .read_range(reference.id, range, mode)
        .await
}

#[tauri::command]
pub async fn response_content_read_lines(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResponseContentState>,
    reference: ResponseContentRef,
    cursor: Option<String>,
    limit: usize,
) -> Result<LinePage, String> {
    state
        .handle(&app)?
        .read_lines(reference.id, cursor, limit)
        .await
}

#[tauri::command]
pub async fn response_content_search(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResponseContentState>,
    operations: tauri::State<'_, ContentOperationState>,
    operation_id: String,
    reference: ResponseContentRef,
    query: SearchQuery,
    cursor: Option<String>,
) -> Result<SearchPage, String> {
    let handle = state.handle(&app)?;
    let cancelled = operations.register(&operation_id)?;
    let result = handle.search(reference.id, query, cursor, cancelled).await;
    operations.finish(&operation_id);
    result
}

#[tauri::command]
pub async fn response_content_format(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResponseContentState>,
    operations: tauri::State<'_, ContentOperationState>,
    operation_id: String,
    reference: ResponseContentRef,
    request: FormatRequest,
) -> Result<ContentOperationResult, String> {
    let handle = state.handle(&app)?;
    let cancelled = operations.register(&operation_id)?;
    let result = handle.format(reference.id, request, cancelled).await;
    operations.finish(&operation_id);
    result
}

#[tauri::command]
pub async fn response_content_query(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResponseContentState>,
    operations: tauri::State<'_, ContentOperationState>,
    operation_id: String,
    reference: ResponseContentRef,
    request: JsonQueryRequest,
) -> Result<ContentOperationResult, String> {
    let handle = state.handle(&app)?;
    let cancelled = operations.register(&operation_id)?;
    let result = handle.query(reference.id, request, cancelled).await;
    operations.finish(&operation_id);
    result
}

#[tauri::command]
pub fn cancel_response_content_operation(
    operation_id: String,
    operations: tauri::State<'_, ContentOperationState>,
) -> Result<(), String> {
    operations.cancel(&operation_id)
}

#[tauri::command]
pub async fn response_content_release(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResponseContentState>,
    reference: ResponseContentRef,
) -> Result<(), String> {
    state.handle(&app)?.release(reference.id).await
}

#[cfg(test)]
mod tests {
    use super::{extension_of, safe_file_name};

    #[test]
    fn suggested_names_cannot_escape_the_save_dialog() {
        assert_eq!(safe_file_name("../../report?.pdf"), "-..-report-.pdf");
        assert_eq!(safe_file_name("..."), "response.bin");
    }

    #[test]
    fn extensions_are_bounded_and_sanitized() {
        assert_eq!(extension_of("archive.tar.gz"), "gz");
        assert_eq!(extension_of("response.bad!type"), "badtype");
    }
}
