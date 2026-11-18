use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WeatherLocation {
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
}
impl WeatherLocation {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty()
            || self.name.len() > 200
            || !self.latitude.is_finite()
            || !(-90.0..=90.0).contains(&self.latitude)
            || !self.longitude.is_finite()
            || !(-180.0..=180.0).contains(&self.longitude)
        {
            return Err("Lokasi cuaca tidak valid.".into());
        }
        Ok(())
    }
}
fn follow_windows() -> bool {
    true
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Features {
    pub media: bool,
    pub tray: bool,
    pub sharing: bool,
    pub notifications: bool,
    pub activity: bool,
}
impl Default for Features {
    fn default() -> Self {
        Self {
            media: true,
            tray: true,
            sharing: true,
            notifications: true,
            activity: true,
        }
    }
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub features: Features,
    pub widgets: Vec<String>,
    pub weather_location: Option<WeatherLocation>,
    #[serde(default = "follow_windows")]
    pub weather_follow_windows: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            features: Features::default(),
            widgets: [
                "quicksettings",
                "sysmon",
                "calendar",
                "pomodoro",
                "lyric",
                "weather",
            ]
            .map(str::to_owned)
            .to_vec(),
            weather_location: None,
            weather_follow_windows: true,
        }
    }
}
pub fn load(app: &AppHandle) -> Config {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|root| std::fs::read(root.join("features.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
pub fn open(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_async(app).await {
            eprintln!("Tidak dapat membuka konfigurasi: {error}");
        }
    });
}

async fn open_async(app: AppHandle) -> Result<(), String> {
    static OPEN_LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
    let _guard = OPEN_LOCK.lock().await;
    // WebView2 creation must run outside Windows UI and synchronous IPC callbacks.
    tauri::async_runtime::spawn_blocking(move || build_window(&app))
        .await
        .map_err(|error| error.to_string())?
}

fn build_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?settings".into()),
    )
    .title("Konfigurasi NotchApp")
    .inner_size(760.0, 700.0)
    .min_inner_size(600.0, 500.0)
    .center()
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn config_get(app: AppHandle) -> Config {
    load(&app)
}
#[tauri::command]
pub async fn config_open(app: AppHandle) -> Result<(), String> {
    open_async(app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_users_keep_features_and_widgets_by_default() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert!(
            config.features.media
                && config.features.notifications
                && config.features.tray
                && config.features.sharing
        );
        assert_eq!(config.widgets.len(), 6);
        assert!(config.weather_location.is_none());
        assert!(config.weather_follow_windows);
    }
    #[test]
    fn disabled_services_and_empty_widgets_survive_serialization() {
        let mut config = Config::default();
        config.features = Features {
            media: false,
            tray: false,
            sharing: false,
            notifications: false,
            activity: false,
        };
        config.widgets.clear();
        let decoded: Config =
            serde_json::from_slice(&serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(
            !decoded.features.media
                && !decoded.features.notifications
                && !decoded.features.sharing
                && !decoded.features.tray
        );
        assert!(decoded.widgets.is_empty());
    }
    #[test]
    fn weather_locations_validate_ranges_and_round_trip() {
        for (latitude, longitude) in [(91.0, 0.0), (0.0, -181.0), (f64::NAN, 0.0)] {
            assert!(
                WeatherLocation {
                    name: "Test".into(),
                    latitude,
                    longitude
                }
                .validate()
                .is_err()
            );
        }
        let mut config = Config::default();
        config.weather_follow_windows = false;
        config.weather_location = Some(WeatherLocation {
            name: "Kota pilihan".into(),
            latitude: 0.0,
            longitude: 0.0,
        });
        let copy: Config = serde_json::from_value(serde_json::to_value(config).unwrap()).unwrap();
        assert!(!copy.weather_follow_windows);
        assert_eq!(copy.weather_location.unwrap().latitude, 0.0);
    }
}
#[tauri::command]
pub fn config_save(
    app: AppHandle,
    mut config: Config,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Buka jendela konfigurasi untuk mengubah pengaturan.".into());
    }
    if let Some(location) = &config.weather_location {
        location.validate()?;
    }
    let valid = Config::default().widgets;
    if config.widgets.iter().any(|id| !valid.contains(id)) {
        return Err("Widget tidak dikenal.".into());
    }
    config.widgets.sort();
    config.widgets.dedup();
    if config.features.sharing && !config.features.tray {
        return Err("Sharing memerlukan Tray sebagai penampung file.".into());
    }
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(root.join("features.tmp"), bytes).map_err(|e| e.to_string())?;
    std::fs::rename(root.join("features.tmp"), root.join("features.json"))
        .map_err(|e| e.to_string())?;
    app.restart();
}
