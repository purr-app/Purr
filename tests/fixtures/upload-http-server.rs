//! Synthetic loopback upload sink shared by native protected-stream tests.
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

pub struct CapturedRequest {
    pub headers: String,
    pub body: Vec<u8>,
    pub declared_length: usize,
}
fn read_request(stream: &mut TcpStream) -> io::Result<CapturedRequest> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Incomplete test upload",
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]).into_owned();
            let lengths = headers
                .lines()
                .filter_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .collect::<Vec<_>>();
            assert_eq!(
                lengths.len(),
                1,
                "exactly one known Content-Length required"
            );
            if bytes.len() >= end + 4 + lengths[0] {
                return Ok(CapturedRequest {
                    headers,
                    body: bytes[end + 4..].to_vec(),
                    declared_length: lengths[0],
                });
            }
        }
    }
}
pub struct UploadServer {
    pub address: SocketAddr,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
    thread: thread::JoinHandle<()>,
}
impl UploadServer {
    pub fn start(statuses: Vec<u16>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let thread = thread::spawn(move || {
            for status in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream).unwrap();
                captured.lock().unwrap().push(request);
                write!(stream,"HTTP/1.1 {status} Test\r\nLocation: /replay\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
        });
        Self {
            address,
            requests,
            thread,
        }
    }
    pub fn finish(self) -> Vec<CapturedRequest> {
        self.thread.join().unwrap();
        Arc::try_unwrap(self.requests)
            .ok()
            .unwrap()
            .into_inner()
            .unwrap()
    }
}
pub struct PausedUpload {
    pub address: SocketAddr,
    pub started: tokio::sync::oneshot::Receiver<()>,
    release: mpsc::Sender<()>,
    thread: thread::JoinHandle<()>,
}
impl PausedUpload {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, started) = tokio::sync::oneshot::channel();
        let (release, wait) = mpsc::channel();
        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).unwrap() > 0);
            let _ = tx.send(());
            let _ = wait.recv_timeout(Duration::from_secs(10));
        });
        Self {
            address,
            started,
            release,
            thread,
        }
    }
    pub fn finish(self) {
        let _ = self.release.send(());
        self.thread.join().unwrap();
    }
}
