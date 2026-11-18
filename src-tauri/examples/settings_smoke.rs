//! Native WebView regression check; it never saves preferences or requests location.
#[path = "../src/config.rs"]
#[allow(dead_code)]
mod config;
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{Manager, WebviewUrl};

static PHASE: AtomicU8 = AtomicU8::new(0);

#[tauri::command]
async fn settings_smoke_ready(app: tauri::AppHandle) {
    match PHASE.fetch_add(1, Ordering::SeqCst) {
        0 => {
            println!("PASS: menu/UI event opened settings and React rendered");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            app.get_webview_window("settings").unwrap().close().unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            app.get_webview_window("main")
                .unwrap()
                .eval("window.__TAURI_INTERNALS__.invoke('config_open').catch(console.error)")
                .unwrap();
        }
        1 => {
            println!("PASS: real config_open IPC recreated settings and React rendered");
            tokio::try_join!(
                config::config_open(app.clone()),
                config::config_open(app.clone()),
                config::config_open(app.clone())
            )
            .expect("concurrent settings requests failed");
            println!("PASS: concurrent requests reuse the existing settings window");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            PHASE.store(3, Ordering::SeqCst);
            app.exit(0);
        }
        _ => {}
    }
}

fn main() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(20));
        if PHASE.load(Ordering::SeqCst) < 3 {
            eprintln!(
                "FAIL: settings did not render; completed phases={}",
                PHASE.load(Ordering::SeqCst)
            );
            std::process::exit(1);
        }
    });
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows[0].visible = false;
    context.config_mut().app.windows[0].url = WebviewUrl::App("index.html?settings".into());
    tauri::Builder::default()
        .on_page_load(|window, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished { return; }
            if window.label() == "main" {
                // Same UI-thread boundary as the native menu callback.
                let _ = config::open(window.app_handle());
            } else if window.label() == "settings" {
                window.eval(r#"
                    (() => {
                      const check = () => {
                        if (document.querySelector('h1')?.textContent === 'Atur notch Anda' && document.querySelector('fieldset input')) {
                          window.__TAURI_INTERNALS__.invoke('settings_smoke_ready');
                        } else setTimeout(check, 50);
                      };
                      check();
                    })()
                "#).unwrap();
            }
        })
        .invoke_handler(tauri::generate_handler![config::config_get, config::config_open, settings_smoke_ready])
        .run(context).expect("native settings smoke check failed");
}
