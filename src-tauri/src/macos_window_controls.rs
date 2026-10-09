//! Compact native traffic lights for shells using an overlay titlebar.

use objc2::{msg_send, MainThreadMarker};
use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
use objc2_foundation::{NSPoint, NSSize};
use tauri::{plugin::TauriPlugin, Manager, Window, WindowEvent, Wry};

const BUTTON_SIZE: f64 = 12.0;
const BUTTON_PITCH: f64 = 20.0;

pub fn init() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("window-controls")
        .on_window_ready(|window| {
            schedule_layout(window.clone());
            let target = window.clone();
            window.on_window_event(move |event| {
                if matches!(
                    event,
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
                ) {
                    schedule_layout(target.clone());
                }
            });
        })
        .build()
}

fn schedule_layout(window: Window<Wry>) {
    // Respect a consumer shell's native titlebar unless it opts into positioned controls.
    let Some(position) = window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == window.label())
        .and_then(|config| config.traffic_light_position.clone())
    else {
        return;
    };
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Some(_main_thread) = MainThreadMarker::new() else {
            return;
        };
        let Ok(pointer) = target.ns_window() else {
            return;
        };
        // Tauri owns this NSWindow; it is borrowed only during this main-thread callback.
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        // The window owns its content view. Borrow it for this synchronous
        // main-thread layout; do not participate in the optimized Objective-C
        // autoreleased-return handshake on every resize. In optimized macOS
        // builds that handshake can over-release Wry's content view on drop.
        let pointer: *mut NSView = unsafe { msg_send![native, contentView] };
        let Some(content) = (unsafe { pointer.as_ref() }) else {
            return;
        };
        let content_bounds = content.bounds();
        // The configured y is the center offset from the top of the content:
        // 20 logical pixels aligns with Purr's 40-pixel application header.
        let center_y = content_bounds.origin.y
            + if content.isFlipped() {
                position.y
            } else {
                content_bounds.size.height - position.y
            };
        for (index, kind) in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ]
        .into_iter()
        .enumerate()
        {
            let Some(button) = native.standardWindowButton(kind) else {
                continue;
            };
            // Read the existing AppKit hierarchy only on the main thread.
            let Some(parent) = (unsafe { button.superview() }) else {
                continue;
            };
            let center = parent.convertPoint_fromView(NSPoint::new(0.0, center_y), Some(content));
            let bounds = button.bounds();
            let mut frame = button.frame();
            frame.origin.x = position.x + index as f64 * BUTTON_PITCH;
            frame.origin.y = center.y - BUTTON_SIZE / 2.0;
            frame.size = NSSize::new(BUTTON_SIZE, BUTTON_SIZE);
            button.setFrame(frame);
            // Scale the existing native drawing (including hover glyphs), keeping its
            // logical bounds stable so repeated resize events cannot shrink it again.
            button.setBoundsSize(bounds.size);
        }
    });
}
