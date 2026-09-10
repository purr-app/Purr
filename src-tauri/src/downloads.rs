use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use tauri_plugin_dialog::DialogExt;

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

#[cfg(test)]
mod tests {
    use super::safe_file_name;

    #[test]
    fn suggested_names_cannot_escape_the_save_dialog() {
        assert_eq!(safe_file_name("../../report?.pdf"), "-..-report-.pdf");
        assert_eq!(safe_file_name("..."), "response.bin");
    }
}
