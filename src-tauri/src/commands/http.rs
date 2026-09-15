use crate::http::{perform_http, HttpClient, HttpRequest, HttpResponse};

#[tauri::command]
pub async fn send_http(
    request: HttpRequest,
    client: tauri::State<'_, HttpClient>,
) -> Result<HttpResponse, String> {
    perform_http(request, &client.0).await
}
