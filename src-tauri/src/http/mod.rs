mod operations;
mod transport;

pub use operations::HttpOperationState;
pub use transport::{
    http_url, perform_http_with_files, HttpClient, HttpEvent, HttpRequest, HttpResponse,
};
pub mod request_body;

#[derive(Default)]
pub struct HttpRuntimeState {
    pub(crate) client: HttpClient,
    pub(crate) operations: HttpOperationState,
    pub(crate) request_files: request_body::RequestFileState,
}
