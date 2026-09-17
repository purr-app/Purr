use super::{
    correlation::ExchangeInput,
    domain::{ObservabilityError, TraceQuery},
    service::{Integration, NativeFuture, Repository},
};
use crate::{
    content::{actor::ResponseContentState, contracts::ByteRange},
    persistence::{runtime, PersistenceState},
};
use tauri::Manager;
use zeroize::Zeroizing;

pub struct NativeRepository(pub tauri::AppHandle);
impl Repository for NativeRepository {
    fn integrations(&self, workspace: &str) -> NativeFuture<'_, Vec<Integration>> {
        let app = self.0.clone();
        let workspace = workspace.to_owned();
        Box::pin(async move {
            tauri::async_runtime::spawn_blocking(move || {
                runtime::observability_integrations(
                    &app,
                    &app.state::<PersistenceState>(),
                    &workspace,
                )
            })
            .await
            .map_err(|_| ObservabilityError::StorageUnavailable)?
        })
    }
    fn secret(&self, reference: &str) -> NativeFuture<'_, Option<Zeroizing<String>>> {
        let app = self.0.clone();
        let reference = reference.to_owned();
        Box::pin(async move {
            tauri::async_runtime::spawn_blocking(move || {
                runtime::secure_get(app.clone(), app.state::<PersistenceState>(), reference)
                    .map(|value| value.map(Zeroizing::new))
                    .map_err(|_| ObservabilityError::CredentialUnavailable)
            })
            .await
            .map_err(|_| ObservabilityError::StorageUnavailable)?
        })
    }
    fn exchange(
        &self,
        query: &TraceQuery,
        read_body_prefix: bool,
    ) -> NativeFuture<'_, ExchangeInput> {
        let app = self.0.clone();
        let query = query.clone();
        Box::pin(async move {
            let handle = app.clone();
            let mut input = tauri::async_runtime::spawn_blocking(move || {
                runtime::observability_exchange(
                    &handle,
                    &handle.state::<PersistenceState>(),
                    &query,
                )
            })
            .await
            .map_err(|_| ObservabilityError::StorageUnavailable)??;
            if let Some(id) = input.content_id.as_ref().filter(|_| read_body_prefix) {
                input.body_prefix = app
                    .state::<ResponseContentState>()
                    .handle(&app)
                    .map_err(|_| ObservabilityError::StorageUnavailable)?
                    .read_bytes_range(
                        id.clone(),
                        ByteRange {
                            offset: 0,
                            length: 64 * 1024,
                        },
                    )
                    .await
                    .map_err(|_| ObservabilityError::StorageUnavailable)?;
            }
            Ok(input)
        })
    }
}
