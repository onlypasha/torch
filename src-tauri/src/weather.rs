use crate::config::WeatherLocation;
use serde_json::Value;
use std::{sync::OnceLock, time::Duration};
use tauri::{AppHandle, WebviewWindow};
use windows::{
    Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy},
    Foundation::TimeSpan,
};

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(12))
                .connect_timeout(Duration::from_secs(5))
                .user_agent("NotchApp/0.1 (weather)")
                .build()
                .map_err(|_| "Layanan cuaca tidak dapat dimulai.".into())
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn json(url: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let mut response = client()?
        .get(url)
        .query(query)
        .send()
        .await
        .map_err(|_| "Cuaca gagal dimuat. Periksa koneksi internet.".to_owned())?
        .error_for_status()
        .map_err(|_| "Penyedia cuaca belum dapat dihubungi.".to_owned())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Unduhan cuaca terputus.".to_owned())?
    {
        if bytes.len() + chunk.len() > 128 * 1024 {
            return Err("Respons cuaca terlalu besar.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Respons cuaca tidak valid.".into())
}

#[tauri::command]
pub async fn weather_search(query: String) -> Result<Vec<WeatherLocation>, String> {
    let query = query.trim();
    if !(2..=120).contains(&query.chars().count()) {
        return Err("Masukkan nama kota, minimal 2 huruf.".into());
    }
    let data = json(
        "https://geocoding-api.open-meteo.com/v1/search",
        &[
            ("name", query.to_owned()),
            ("count", "5".into()),
            ("language", "id".into()),
        ],
    )
    .await?;
    let mut locations = Vec::new();
    for item in data["results"].as_array().into_iter().flatten() {
        let (Some(name), Some(latitude), Some(longitude)) = (
            item["name"].as_str(),
            item["latitude"].as_f64(),
            item["longitude"].as_f64(),
        ) else {
            continue;
        };
        let region = item["admin1"].as_str().unwrap_or("");
        let country = item["country"].as_str().unwrap_or("");
        let location = WeatherLocation {
            name: [name, region, country]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", "),
            latitude,
            longitude,
        };
        if location.validate().is_ok() {
            locations.push(location);
        }
    }
    Ok(locations)
}

async fn windows_location() -> Result<WeatherLocation, String> {
    tauri::async_runtime::spawn_blocking(read_windows_location)
        .await
        .map_err(|_| "Pembacaan lokasi Windows terhenti.".to_owned())?
}

fn read_windows_location() -> Result<WeatherLocation, String> {
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        .map_err(|_| "Layanan Lokasi Windows tidak dapat dimulai.".to_owned())?;
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                RoUninitialize();
            }
        }
    }
    let _apartment = Apartment;
    let locator =
        Geolocator::new().map_err(|_| "Layanan Lokasi Windows tidak tersedia.".to_owned())?;
    locator
        .SetDesiredAccuracy(PositionAccuracy::Default)
        .map_err(|e| e.to_string())?;
    let operation = locator
        .GetGeopositionAsyncWithAgeAndTimeout(
            TimeSpan {
                Duration: 15 * 60 * 10_000_000,
            },
            TimeSpan {
                Duration: 10 * 10_000_000,
            },
        )
        .map_err(|_| "Lokasi Windows tidak dapat dibaca.".to_owned())?;
    let position = operation.get().map_err(|_| {
        "Lokasi Windows belum tersedia. Aktifkan layanan lokasi atau pilih kota manual.".to_owned()
    })?;
    let coordinates = position
        .Coordinate()
        .and_then(|c| c.Point())
        .and_then(|p| p.Position())
        .map_err(|e| e.to_string())?;
    let location = WeatherLocation {
        name: "Lokasi Windows".into(),
        latitude: (coordinates.Latitude * 100.0).round() / 100.0,
        longitude: (coordinates.Longitude * 100.0).round() / 100.0,
    };
    location.validate()?;
    Ok(location)
}

#[tauri::command]
pub async fn weather_windows_location(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<WeatherLocation, String> {
    if window.label() != "settings" {
        return Err("Aktifkan lokasi dari Pengaturan NotchApp.".into());
    }
    window.set_focus().map_err(|e| e.to_string())?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(Geolocator::RequestAccessAsync());
    })
    .map_err(|e| e.to_string())?;
    let access = receive
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "Permintaan izin lokasi tidak dapat ditampilkan.".to_owned())?
        .await
        .map_err(|_| "Izin lokasi Windows gagal diperiksa.".to_owned())?;
    if access != GeolocationAccessStatus::Allowed {
        return Err("Akses lokasi ditolak. Buka Pengaturan Windows > Privasi & keamanan > Lokasi, atau pilih kota manual.".into());
    }
    windows_location().await
}

#[tauri::command]
pub async fn weather_get(location: WeatherLocation, follow_windows: bool) -> Result<Value, String> {
    location.validate()?;
    let location = if follow_windows {
        windows_location().await?
    } else {
        location
    };
    json(
        "https://api.open-meteo.com/v1/forecast",
        &[
            ("latitude", location.latitude.to_string()),
            ("longitude", location.longitude.to_string()),
            ("current", "temperature_2m,weather_code,is_day".into()),
            ("hourly", "temperature_2m".into()),
            ("forecast_hours", "12".into()),
            ("timezone", "auto".into()),
            ("timeformat", "unixtime".into()),
            ("temperature_unit", "celsius".into()),
        ],
    )
    .await
}

#[tauri::command]
pub fn weather_open_source() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("https://open-meteo.com/")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Contacts the public weather provider with the named test city; no device location"]
    async fn live_provider() {
        let cities = weather_search("Jakarta".into()).await.unwrap();
        assert!(!cities.is_empty());
        let data = weather_get(cities[0].clone(), false).await.unwrap();
        assert!(data["current"]["temperature_2m"].as_f64().is_some());
        assert!(data["current"]["time"].as_i64().unwrap() > 1_700_000_000);
        assert!(data["hourly"]["time"].as_array().unwrap().len() >= 4);
        println!(
            "Live weather search/current/hourly succeeded; timezone={}",
            data["timezone"]
        );
    }
}
