//! Exercise the real Wry/AppKit view hierarchy on the process main thread.

#[cfg(target_os = "macos")]
fn main() {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tauri::{Manager, RunEvent, WindowEvent};

    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.purr.window-resize-test".into();
    let config = &mut context.config_mut().app.windows[0];
    config.visible = false;
    config.url = tauri::WebviewUrl::External("about:blank".parse().unwrap());
    let resizes = Arc::new(AtomicUsize::new(0));
    let observed = resizes.clone();
    let plugin: tauri::plugin::TauriPlugin<tauri::Wry> =
        tauri::plugin::Builder::new("window-resize-test")
            .on_event(move |app, event| match event {
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::Resized(_),
                    ..
                } if label == "main" => {
                    observed.fetch_add(1, Ordering::SeqCst);
                }
                RunEvent::Ready => {
                    let window = app.get_webview_window("main").unwrap();
                    let app = app.clone();
                    let observed = observed.clone();
                    std::thread::spawn(move || {
                        for index in 0..64 {
                            window
                                .set_size(tauri::LogicalSize::new(
                                    900.0 + (index % 2) as f64 * 380.0,
                                    600.0 + (index % 2) as f64 * 200.0,
                                ))
                                .unwrap();
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        let exit = app.clone();
                        app.run_on_main_thread(move || {
                            let count = observed.load(Ordering::SeqCst);
                            println!("Native macOS resize smoke test: {count} resize events");
                            exit.exit(if count >= 32 { 0 } else { 1 });
                        })
                        .unwrap();
                    });
                    std::thread::spawn(|| {
                        std::thread::sleep(Duration::from_secs(15));
                        eprintln!("Native macOS resize smoke test timed out");
                        std::process::exit(2);
                    });
                }
                _ => {}
            })
            .build();
    purr_lib::core_builder()
        .plugin(plugin)
        .run(context)
        .unwrap();
}

#[cfg(not(target_os = "macos"))]
fn main() {}
