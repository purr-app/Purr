use crate::observability::{
    domain::{IntegrationSummary, ObservabilityError, TracePage, TraceQuery},
    native::NativeRepository,
    ObservabilityState,
};

#[tauri::command]
pub fn observability_validate_config(
    state: tauri::State<'_, ObservabilityState>,
    provider: String,
    version: u32,
    config: serde_json::Value,
) -> Result<serde_json::Value, ObservabilityError> {
    if serde_json::to_vec(&config)
        .map_err(|_| ObservabilityError::InvalidConfig)?
        .len()
        > 65536
    {
        return Err(ObservabilityError::LimitExceeded);
    }
    state.service.validate_config(&provider, version, &config)
}

#[tauri::command]
pub async fn observability_integrations(
    app: tauri::AppHandle,
    state: tauri::State<'_, ObservabilityState>,
    workspace_id: String,
) -> Result<Vec<IntegrationSummary>, ObservabilityError> {
    state
        .service
        .list(&NativeRepository(app), &workspace_id)
        .await
}

#[tauri::command]
pub async fn observability_trace(
    app: tauri::AppHandle,
    state: tauri::State<'_, ObservabilityState>,
    operation_id: String,
    query: TraceQuery,
) -> Result<TracePage, ObservabilityError> {
    let cancellation = state
        .operations
        .register(&operation_id)
        .map_err(|_| ObservabilityError::Busy)?;
    let result = state
        .service
        .lookup(&NativeRepository(app), query, cancellation)
        .await;
    state.operations.finish(&operation_id);
    result
}

#[tauri::command]
pub fn cancel_observability(
    state: tauri::State<'_, ObservabilityState>,
    operation_id: String,
) -> Result<(), ObservabilityError> {
    state
        .operations
        .cancel(&operation_id)
        .map_err(|_| ObservabilityError::InvalidQuery)
}
