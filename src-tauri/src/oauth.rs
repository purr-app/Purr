use crate::http::http_url;
use reqwest::Url;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

#[derive(Default)]
pub struct OAuthCallbacks(Mutex<HashMap<String, oneshot::Sender<()>>>);

fn callback_url(value: &str) -> Result<Url, String> {
    let url = http_url(value)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Callback must use http://127.0.0.1:<port>/<path>, without a query or fragment.".into(),
        );
    }
    Ok(url)
}

fn callback_code(target: &str, callback: &Url, state: &str) -> Result<Option<String>, String> {
    let received = callback.join(target).map_err(|_| "Invalid callback.")?;
    if received.path() != callback.path() || received.origin() != callback.origin() {
        return Ok(None);
    }
    let params: Vec<_> = received.query_pairs().collect();
    let states: Vec<_> = params.iter().filter(|(k, _)| k == "state").collect();
    if states.len() != 1 || states[0].1 != state {
        return Ok(None);
    }
    if params.iter().any(|(k, _)| k == "error") {
        return Err("Authorization was declined by the provider.".into());
    }
    let codes: Vec<_> = params.iter().filter(|(k, _)| k == "code").collect();
    if codes.len() != 1 || codes[0].1.is_empty() {
        return Err("The provider did not return an authorization code.".into());
    }
    Ok(Some(codes[0].1.to_string()))
}

#[tauri::command]
pub fn cancel_oauth(session_id: String, sessions: tauri::State<'_, OAuthCallbacks>) {
    if let Some(sender) = sessions
        .0
        .lock()
        .expect("callback lock")
        .remove(&session_id)
    {
        let _ = sender.send(());
    }
}

#[tauri::command]
pub async fn authorize_oauth(
    app: tauri::AppHandle,
    authorization_url: String,
    redirect_uri: String,
    state: String,
    session_id: String,
    sessions: tauri::State<'_, OAuthCallbacks>,
) -> Result<String, String> {
    let authorization = http_url(&authorization_url)?;
    if authorization.scheme() != "https"
        && !matches!(
            authorization.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]")
        )
    {
        return Err(
            "Authorization URL must use HTTPS (HTTP is allowed for local development).".into(),
        );
    }
    let callback = callback_url(&redirect_uri)?;
    let (sender, mut canceled) = oneshot::channel();
    sessions
        .0
        .lock()
        .expect("callback lock")
        .insert(session_id.clone(), sender);
    let result = async {
        let listener = TcpListener::bind(("127.0.0.1", callback.port().unwrap())).await
            .map_err(|_| "Callback port is unavailable. Choose another port and register that callback with the provider.")?;
        if canceled.try_recv().is_ok() { return Err("Authorization canceled.".into()); }
        app.opener().open_url(authorization.as_str(), None::<&str>).map_err(|_| "Could not open the system browser.")?;
        let receive = receive_callback(listener, &callback, &state);
        tokio::select! {
            _ = &mut canceled => Err("Authorization canceled.".into()),
            received = tokio::time::timeout(Duration::from_secs(180), receive) => received.unwrap_or_else(|_| Err("Authorization timed out. Try again.".into()))
        }
    }.await;
    sessions
        .0
        .lock()
        .expect("callback lock")
        .remove(&session_id);
    result
}

async fn receive_callback(
    listener: TcpListener,
    callback: &Url,
    state: &str,
) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "Callback listener failed.")?;
        let mut request = Vec::new();
        let read = async {
            let mut buffer = [0; 1024];
            while request.len() < 16 * 1024 {
                let count = stream.read(&mut buffer).await?;
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            Ok::<_, std::io::Error>(())
        };
        if !matches!(
            tokio::time::timeout(Duration::from_secs(2), read).await,
            Ok(Ok(()))
        ) {
            continue;
        }
        let text = String::from_utf8_lossy(&request);
        let mut line = text.lines().next().unwrap_or("").split_whitespace();
        let parsed = if line.next() == Some("GET") {
            callback_code(line.next().unwrap_or(""), callback, state)
        } else {
            Ok(None)
        };
        let (status, message) = match &parsed {
            Ok(Some(_)) => (
                "200 OK",
                "Authorization complete. You can close this tab and return to Purr.",
            ),
            Err(_) => (
                "400 Bad Request",
                "Authorization failed. Return to Purr to try again.",
            ),
            _ => ("400 Bad Request", "Invalid authorization callback."),
        };
        let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{message}", message.len());
        let _ =
            tokio::time::timeout(Duration::from_secs(2), stream.write_all(reply.as_bytes())).await;
        match parsed {
            Ok(Some(code)) => return Ok(code),
            Err(err) => return Err(err),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn loopback_receiver_ignores_wrong_state_then_accepts_code() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let callback = callback_url(&format!(
            "http://{}/oauth/callback",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let url = callback.clone();
        let receiver =
            tokio::spawn(
                async move { receive_callback(listener, &callback, "expected-state").await },
            );
        let client = reqwest::Client::new();
        let invalid = client
            .get(format!("{}?state=wrong&code=bad", url))
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), 400);
        let valid = client
            .get(format!("{}?state=expected-state&code=good-code", url))
            .send()
            .await
            .unwrap();
        assert_eq!(valid.status(), 200);
        assert!(!valid.text().await.unwrap().contains("good-code"));
        assert_eq!(receiver.await.unwrap().unwrap(), "good-code");
    }
    #[test]
    fn callback_requires_loopback_and_port() {
        assert!(callback_url("http://127.0.0.1:8976/oauth/callback").is_ok());
        for value in [
            "https://example.com/callback",
            "http://0.0.0.0:8976/callback",
            "http://127.0.0.1/callback",
        ] {
            assert!(callback_url(value).is_err());
        }
    }
    #[test]
    fn callback_checks_path_state_and_duplicate_parameters() {
        let url = callback_url("http://127.0.0.1:8976/oauth/callback").unwrap();
        assert_eq!(
            callback_code("/oauth/callback?state=expected&code=abc", &url, "expected").unwrap(),
            Some("abc".into())
        );
        for value in [
            "/other?state=expected&code=abc",
            "/oauth/callback?state=wrong&code=abc",
            "/oauth/callback?state=expected&state=bad&code=abc",
        ] {
            assert_eq!(callback_code(value, &url, "expected").unwrap(), None);
        }
        assert!(callback_code(
            "/oauth/callback?state=expected&error=access_denied",
            &url,
            "expected"
        )
        .is_err());
    }
}
