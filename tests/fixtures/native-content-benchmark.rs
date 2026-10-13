// Synthetic scoped response storage; no platform key store or application profile.
// Run this ignored test in a fresh process per policy so peak RSS is comparable.
#[test]
#[ignore = "synthetic performance comparison; run explicitly with --nocapture"]
fn native_content_comparison() {
    let policy = std::env::var("PURR_BENCH_PROTECTION").unwrap_or_else(|_| "encrypted".into());
    assert!(["encrypted", "plaintext"].contains(&policy.as_str()));
    let (_directory, _ciphers, mut store) = scoped_store();
    let reference = store
        .create_staging(ContentMetadata {
            protection: if policy == "plaintext" {
                ResponseContentProtection::Plaintext
            } else {
                ResponseContentProtection::Encrypted
            }, // S05 protection
            workspace_id: "workspace-a".into(),
            media_type: Some("application/octet-stream".into()),
            charset: None,
        })
        .unwrap();
    let chunk = vec![b'x'; 8 * 1024 * 1024];
    let started = Instant::now();
    for _ in 0..8 {
        store.append(&reference.id, &chunk).unwrap();
    }
    let finished = store.finish(&reference.id).unwrap();
    let write_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(finished.byte_length, 64 * 1024 * 1024);
    let started = Instant::now();
    for offset in (0..finished.byte_length).step_by(4 * 1024 * 1024) {
        let bytes = store
            .read_plain_range(&reference.id, offset, 4 * 1024 * 1024)
            .unwrap();
        assert_eq!(bytes.len(), 4 * 1024 * 1024);
        assert!(bytes.iter().all(|byte| *byte == b'x'));
    }
    let read_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    unsafe {
        libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
    }
    let rss = unsafe { usage.assume_init() }.ru_maxrss;
    println!("PURR_CONTENT_BENCH protection={policy} bytes={} write_ms={write_ms:.3} write_mib_s={:.2} read_ms={read_ms:.3} peak_rss_native_units={rss}", finished.byte_length, 64_000.0 / write_ms);
}
