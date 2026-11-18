#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(windows, debug_assertions))]
    if std::env::args().any(|arg| arg == "--notification-status") {
        use windows::{
            ApplicationModel::Package,
            UI::Notifications::{
                Management::{UserNotificationListener, UserNotificationListenerAccessStatus},
                NotificationKinds,
            },
            Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
        };

        if let Err(error) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            println!("winrtError=0x{:08X}", error.code().0 as u32);
            return;
        }
        println!("packageIdentity={}", Package::Current().is_ok());
        match UserNotificationListener::Current() {
            Ok(listener) => match listener.GetAccessStatus() {
                Ok(access) => {
                    println!("accessStatus={access:?}");
                    if access == UserNotificationListenerAccessStatus::Allowed {
                        match listener
                            .GetNotificationsAsync(NotificationKinds::Toast)
                            .and_then(|operation| operation.get())
                        {
                            Ok(items) => println!("notificationCount={}", items.Size().unwrap_or(0)),
                            Err(error) => println!("readError=0x{:08X}", error.code().0 as u32),
                        }
                    }
                }
                Err(error) => println!("accessError=0x{:08X}", error.code().0 as u32),
            },
            Err(error) => println!("accessError=0x{:08X}", error.code().0 as u32),
        }
        unsafe { RoUninitialize() };
        return;
    }
    notch_app_lib::run()
}
