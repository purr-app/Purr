//! The native trust boundary is the bundled main webview, never response content.
use tauri::{ipc::Invoke, Manager, Runtime, Url, Webview};

const DENIED: &str = "native-caller-denied";

pub(crate) fn trusted_url(url: &Url, dev_url: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let bundled = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")));
    bundled
        || dev_url.is_some_and(|expected| {
            matches!(expected.scheme(), "http" | "https") && url.origin() == expected.origin()
        })
}

fn trusted_label(window: &str, webview: &str) -> bool {
    window == "main" && webview == "main"
}

pub(crate) fn require_trusted_webview<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    let url = webview.url().map_err(|_| DENIED)?;
    let config = webview.app_handle().config();
    let dev_url = tauri::is_dev()
        .then_some(config.build.dev_url.as_ref())
        .flatten();
    if trusted_label(webview.window_ref().label(), webview.label()) && trusted_url(&url, dev_url) {
        Ok(())
    } else {
        Err(DENIED.into())
    }
}

/// Tauri's ACL is computed from the actual IPC request origin (including frames).
/// Require it as well as the current top-level URL: a downstream binary cannot
/// accidentally expose core commands by omitting its application permissions.
pub(crate) fn guard<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !has_local_permission(invoke.acl.as_deref())
            || require_trusted_webview(invoke.message.webview_ref()).is_err()
        {
            invoke.resolver.reject(DENIED);
            return true;
        }
        handler(invoke)
    }
}

fn has_local_permission(
    permissions: Option<&[tauri::utils::acl::resolved::ResolvedCommand]>,
) -> bool {
    permissions.is_some_and(|permissions| {
        permissions.iter().any(|permission| {
            matches!(
                permission.context,
                tauri::utils::acl::ExecutionContext::Local
            )
        })
    })
}

pub(crate) fn navigation_guard<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("purr-navigation")
        .on_navigation(|webview, url| {
            let config = webview.app_handle().config();
            let dev_url = tauri::is_dev()
                .then_some(config.build.dev_url.as_ref())
                .flatten();
            // srcdoc is used only by the scriptless, opaque-origin response frame.
            trusted_label(webview.window_ref().label(), webview.label())
                && (trusted_url(url, dev_url)
                    || matches!(url.as_str(), "about:blank" | "about:srcdoc"))
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_or_remote_request_acl_never_reaches_core_commands() {
        use tauri::utils::acl::{resolved::ResolvedCommand, ExecutionContext};
        assert!(!has_local_permission(None));
        assert!(!has_local_permission(Some(&[])));
        let remote = ResolvedCommand {
            context: ExecutionContext::Remote {
                url: "https://example.com".parse().unwrap(),
            },
            ..Default::default()
        };
        assert!(!has_local_permission(Some(&[remote])));
        assert!(has_local_permission(Some(&[ResolvedCommand::default()])));
    }

    #[test]
    fn only_the_main_bundled_webview_is_trusted() {
        assert!(trusted_label("main", "main"));
        assert!(!trusted_label("main", "preview"));
        assert!(!trusted_label("preview", "main"));
        for value in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(trusted_url(&Url::parse(value).unwrap(), None), "{value}");
        }
        for value in [
            "https://example.com/",
            "http://localhost:1420/",
            "tauri://evil/",
            "https://tauri.localhost.evil/",
            "https://user@tauri.localhost/",
            "http://tauri.localhost:8080/",
            "purr-content://localhost/id",
            "http://purr-content.localhost/id",
            "about:srcdoc",
            "data:text/html,test",
            "file:///tmp/index.html",
        ] {
            assert!(!trusted_url(&Url::parse(value).unwrap(), None), "{value}");
        }
    }

    #[test]
    fn development_allows_only_the_configured_origin() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        assert!(trusted_url(
            &Url::parse("http://localhost:1420/src/App.tsx").unwrap(),
            Some(&dev)
        ));
        for value in [
            "http://localhost:1421",
            "http://127.0.0.1:1420",
            "https://localhost:1420",
            "http://localhost.evil:1420",
        ] {
            assert!(
                !trusted_url(&Url::parse(value).unwrap(), Some(&dev)),
                "{value}"
            );
        }
    }
}
