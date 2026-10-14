use pp_core::{CoreHandle, CoreStatus};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::AppHandle;

#[derive(Default)]
pub(crate) struct RecoveryGate(AtomicBool);

impl RecoveryGate {
    pub(crate) fn admit(&self, status: &CoreStatus) -> bool {
        matches!(status, CoreStatus::Guarded)
            && self
                .0
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    pub(crate) fn observe(&self, status: &CoreStatus) -> bool {
        if !matches!(status, CoreStatus::Guarded) {
            self.0.store(false, Ordering::Release);
        }
        matches!(status, CoreStatus::Guarded) && !self.0.load(Ordering::Acquire)
    }

    pub(crate) fn refused(&self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(crate) struct RecoveryUi {
    data: PathBuf,
    dialog: Arc<AtomicBool>,
}

impl RecoveryUi {
    pub(crate) fn new(data: PathBuf) -> Self {
        Self {
            data,
            dialog: Arc::default(),
        }
    }

    pub(crate) fn view_logs(&self, app: &AppHandle) {
        if self.dialog.swap(true, Ordering::AcqRel) {
            return;
        }
        let data = self.data.clone();
        let app = app.clone();
        let dialog = self.dialog.clone();
        tauri::async_runtime::spawn(async move {
            let text =
                tauri::async_runtime::spawn_blocking(move || pp_core::recent_diagnostics(&data))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_else(|| "Service logs are unavailable.".to_owned());
            let released = dialog.clone();
            if app
                .run_on_main_thread(move || {
                    show_message("Service logs", &text, move || {
                        released.store(false, Ordering::Release)
                    });
                })
                .is_err()
            {
                dialog.store(false, Ordering::Release);
            }
        });
    }

    pub(crate) fn open_data(&self, app: &AppHandle) {
        let data = self.data.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            #[cfg(target_os = "macos")]
            let opener = "/usr/bin/open";
            #[cfg(not(target_os = "macos"))]
            let opener = "xdg-open";
            let opened = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                tokio::process::Command::new(opener)
                    .arg(data)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .status(),
            )
            .await
            .is_ok_and(|result| result.is_ok_and(|status| status.success()));
            if !opened {
                let _ = app.run_on_main_thread(|| {
                    show_message(
                        "Open data folder",
                        "The data folder could not be opened.",
                        || {},
                    )
                });
            }
        });
    }
}

pub(crate) fn restart(app: &AppHandle, handle: CoreHandle, gate: Arc<RecoveryGate>) {
    if !gate.admit(&handle.subscribe().borrow()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if handle.recover_compat().await.is_err() {
            gate.refused();
            let _ = app.run_on_main_thread(|| {
                show_message(
                    "Restart service",
                    "The service cannot restart in its current state.",
                    || {},
                )
            });
        }
    });
}

fn show_message(title: &str, text: &str, closed: impl Fn() + Send + 'static) {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let dialog = gtk::Dialog::builder()
            .title(title)
            .modal(true)
            .default_width(760)
            .default_height(440)
            .build();
        dialog.add_button("Close", gtk::ResponseType::Close);
        let buffer = gtk::TextBuffer::new(None::<&gtk::TextTagTable>);
        buffer.set_text(text);
        let view = gtk::TextView::builder()
            .buffer(&buffer)
            .editable(false)
            .cursor_visible(false)
            .monospace(true)
            .wrap_mode(gtk::WrapMode::WordChar)
            .build();
        let scroll = gtk::ScrolledWindow::builder()
            .hexpand(true)
            .vexpand(true)
            .build();
        scroll.add(&view);
        dialog.content_area().add(&scroll);
        dialog.connect_response(|dialog, _| dialog.close());
        dialog.connect_destroy(move |_| closed());
        dialog.show_all();
    }
    #[cfg(not(target_os = "linux"))]
    {
        let dialog = rfd::AsyncMessageDialog::new()
            .set_title(title)
            .set_description(text);
        tauri::async_runtime::spawn(async move {
            dialog.show().await;
            closed();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_t_2_native_restart_admits_once_per_guard_episode() {
        let gate = RecoveryGate::default();
        assert!(!gate.admit(&CoreStatus::Starting));
        assert!(gate.observe(&CoreStatus::Guarded));
        assert!(gate.admit(&CoreStatus::Guarded));
        assert!(!gate.admit(&CoreStatus::Guarded));
        assert!(!gate.observe(&CoreStatus::Guarded));
        assert!(!gate.observe(&CoreStatus::Backoff { attempt: 0 }));
        assert!(gate.admit(&CoreStatus::Guarded));
        gate.refused();
        assert!(gate.admit(&CoreStatus::Guarded));
        assert!(!gate.admit(&CoreStatus::Stopping));
    }
}
