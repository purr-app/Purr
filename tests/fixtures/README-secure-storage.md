# Secure storage fixtures

Run the synthetic API with `npx tsx tests/fixtures/secure-storage-server.ts` (localhost port 18765, Ctrl+C to stop).

| Route | Result |
| --- | --- |
| `/health` | `{"ok":true}` |
| `/response?marker=PUBLIC&bytes=8388608&delayMs=5000` | Bounded JSON body, optional padding/delay for policy and cancellation checks |
| `/basic` | Basic username `purr-test`, password `purr-phase1-A` or `purr-phase1-B`; returns credential label A/B |
| `/bearer` | Same synthetic A/B tokens as Bearer; returns label |
| `/cookies/set?credential=A` | Sets a synthetic HttpOnly cookie |
| `/cookies/check` | Reports cookie label A/B/missing |
| `/oauth/token` | Synthetic OAuth token response, no real account |
| `/echo` | Deliberately echoes request values; an Off response may therefore contain secrets in its unclassified body |

Native performance fixtures (`native-content-benchmark.rs`, `native-storage-benchmark.rs`) are included as ignored Rust tests. They use fresh temporary directories and synthetic in-memory root keys, never a real app profile or Keychain. See the test functions for measured operations. Run explicitly with Cargo `--ignored --nocapture`; ordinary CI tests do not run benchmarks. Set `PURR_BENCH_PROTECTION=plaintext` only if supported by that fixture; defaults are encrypted. Benchmark output contains durations/sizes only.
