//! Bounded bridge from authenticated native readers to Reqwest. Dropping the
//! HTTP body closes the pipe and stops its producer after at most one read.
use std::io::{self, Read};
use tokio::io::AsyncWriteExt;

pub const CHUNK_BYTES: usize = 256 * 1024;

pub fn stream_reader(reader: Box<dyn Read + Send>) -> reqwest::Body {
    reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::with_capacity(
        bridge_reader(reader),
        CHUNK_BYTES,
    ))
}
fn bridge_reader(mut reader: Box<dyn Read + Send>) -> CheckedReader {
    let (mut writer, stream) = tokio::io::duplex(CHUNK_BYTES);
    let runtime = tokio::runtime::Handle::current();
    // Errors must reach Reqwest rather than turn corruption into clean EOF.
    let (error_tx, error_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let mut buffer = zeroize::Zeroizing::new(vec![0; CHUNK_BYTES]);
        let result = (|| -> io::Result<()> {
            loop {
                let count = reader.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                runtime.block_on(writer.write_all(&buffer[..count]))?;
            }
            Ok(())
        })();
        let _ = error_tx.send(result);
        drop(writer);
    });
    CheckedReader {
        stream,
        result: error_rx,
        finished: false,
    }
}

struct CheckedReader {
    stream: tokio::io::DuplexStream,
    result: tokio::sync::oneshot::Receiver<io::Result<()>>,
    finished: bool,
}
impl tokio::io::AsyncRead for CheckedReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        use std::{future::Future, pin::Pin, task::Poll};
        if self.finished || buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let before = buffer.filled().len();
        match Pin::new(&mut self.stream).poll_read(cx, buffer) {
            Poll::Ready(Ok(())) if buffer.filled().len() == before => {
                match Pin::new(&mut self.result).poll(cx) {
                    Poll::Ready(result) => {
                        self.finished = true;
                        Poll::Ready(
                            result
                                .unwrap_or_else(|_| Err(io::Error::other("Upload reader stopped"))),
                        )
                    }
                    Poll::Pending => Poll::Pending,
                }
            }
            other => other,
        }
    }
}

#[cfg(test)]
#[path = "upload_stream_tests.rs"]
mod protected_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::AsyncReadExt;
    struct Fails;
    impl Read for Fails {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("Damaged upload"))
        }
    }
    #[tokio::test]
    async fn source_failure_reaches_consumer_instead_of_clean_eof() {
        let mut stream = bridge_reader(Box::new(Fails));
        let mut bytes = Vec::new();
        assert!(stream.read_to_end(&mut bytes).await.is_err());
        assert!(bytes.is_empty());
    }
    struct Infinite {
        reads: Arc<AtomicUsize>,
        dropped: Arc<AtomicBool>,
    }
    impl Read for Infinite {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            assert!(buffer.len() <= CHUNK_BYTES);
            self.reads.fetch_add(1, Ordering::SeqCst);
            buffer.fill(1);
            Ok(buffer.len())
        }
    }
    impl Drop for Infinite {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn backpressure_and_body_drop_bound_work_and_release_reader() {
        let reads = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let stream = bridge_reader(Box::new(Infinite {
            reads: reads.clone(),
            dropped: dropped.clone(),
        }));
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while reads.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            reads.load(Ordering::SeqCst),
            2,
            "only a pipe chunk and one producer chunk may be ahead"
        );
        drop(stream);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !dropped.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }
}
