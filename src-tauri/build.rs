fn main() {
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rerun-if-changed=windows-identity/app.manifest");
        // The package identity used for notification access must match this
        // embedded application manifest when an external-location MSIX is installed.
        tauri_build::try_build(
            tauri_build::Attributes::new().windows_attributes(
                tauri_build::WindowsAttributes::new()
                    .app_manifest(include_str!("windows-identity/app.manifest")),
            ),
        )
        .expect("failed to prepare Windows resources");
    }
    #[cfg(not(target_os = "windows"))]
    tauri_build::build();
}
