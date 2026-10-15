use pp_core::{CoreHandle, CoreStatus, RestoreOutcome, RestoreScope};
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

    pub(crate) fn admit_restore(&self, status: &CoreStatus) -> bool {
        restore_available(status)
            && self
                .0
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    pub(crate) fn restore_enabled(&self, status: &CoreStatus) -> bool {
        restore_available(status) && !self.0.load(Ordering::Acquire)
    }

    pub(crate) fn observe(&self, status: &CoreStatus) -> bool {
        if !restore_available(status) {
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

fn restore_available(status: &CoreStatus) -> bool {
    matches!(status, CoreStatus::Guarded | CoreStatus::Failed)
}

pub(crate) fn restore_backup(app: &AppHandle, handle: CoreHandle, gate: Arc<RecoveryGate>) {
    if !gate.admit_restore(&handle.subscribe().borrow()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let Some(archive) = pick_archive(&app).await else { return Ok(None); };
            let metadata = handle.prepare_restore(archive).await?;
            let scope = match metadata.scope {
                RestoreScope::Legacy => "Legacy backup. Included legacy folders replace current folders. Absent folders are preserved.",
                RestoreScope::Full => "Full backup. All backed-up folders and configuration files replace current data. Missing folders and files are removed.",
                RestoreScope::DatabaseOnly => "Database-only backup. Current folders and configuration files are preserved.",
            };
            let text = format!("Backup created {} by Print Partner {}.\n\n{}\n\nThis replaces your current database and stops the service. Relaunch Print Partner after restore. This action cannot be undone. Restore this backup?", metadata.created_at, metadata.app_version, scope);
            if !confirm_restore(&app, &text).await {
                handle.cancel_restore().await?;
                return Ok(None);
            }
            handle.confirm_restore().await.map(Some)
        }.await;
        gate.refused();
        let text = match result {
            Ok(None) => return,
            Ok(Some(RestoreOutcome::InstalledServiceStopped)) => "Backup files installed. The service is stopped. Quit and relaunch Print Partner to use the restored data.".to_owned(),
            Ok(Some(RestoreOutcome::FailedUnchanged(reason))) => format!("Restore refused. Live files were not changed. Quit Print Partner before retrying.\n\n{reason}"),
            Ok(Some(RestoreOutcome::FailedRolledBack(reason))) => format!("Restore failed. Original files were restored. The service is stopped. Quit Print Partner before retrying.\n\n{reason}"),
            Ok(Some(RestoreOutcome::RecoveryRequired(reason))) => format!("Restore needs recovery. The service is stopped. Keep all data and restore files. Quit and relaunch Print Partner to attempt recovery before service startup.\n\n{reason}"),
            Err(error) => format!("Restore could not complete.\n\n{error:#}"),
        };
        let _ = app.run_on_main_thread(move || show_message("Restore backup", &text, || {}));
    });
}

async fn pick_archive(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let dialog = gtk::FileChooserDialog::new(
                Some("Restore backup"),
                None::<&gtk::Window>,
                gtk::FileChooserAction::Open,
            );
            dialog.add_buttons(&[
                ("Cancel", gtk::ResponseType::Cancel),
                ("Select backup", gtk::ResponseType::Accept),
            ]);
            let send = std::cell::RefCell::new(Some(send));
            dialog.connect_response(move |dialog, response| {
                let path = (response == gtk::ResponseType::Accept)
                    .then(|| dialog.filename())
                    .flatten();
                if let Some(send) = send.borrow_mut().take() {
                    let _ = send.send(path);
                }
                dialog.close();
            });
            dialog.show_all();
        })
        .ok()?;
        receive.await.ok().flatten()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        rfd::AsyncFileDialog::new()
            .set_title("Restore backup")
            .pick_file()
            .await
            .map(|file| file.path().to_owned())
    }
}

async fn confirm_restore(app: &AppHandle, text: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let (send, receive) = tokio::sync::oneshot::channel();
        let text = text.to_owned();
        if app
            .run_on_main_thread(move || {
                let dialog = gtk::MessageDialog::builder()
                    .title("Restore backup")
                    .text("Replace current data with this backup?")
                    .secondary_text(&text)
                    .message_type(gtk::MessageType::Warning)
                    .modal(true)
                    .build();
                dialog.add_buttons(&[
                    ("Cancel", gtk::ResponseType::Cancel),
                    ("Restore backup", gtk::ResponseType::Accept),
                ]);
                dialog.set_default_response(gtk::ResponseType::Cancel);
                let send = std::cell::RefCell::new(Some(send));
                dialog.connect_response(move |dialog, response| {
                    if let Some(send) = send.borrow_mut().take() {
                        let _ = send.send(response == gtk::ResponseType::Accept);
                    }
                    dialog.close();
                });
                dialog.show_all();
            })
            .is_err()
        {
            return false;
        }
        receive.await.unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        rfd::AsyncMessageDialog::new()
            .set_title("Restore backup")
            .set_description(text)
            .set_level(rfd::MessageLevel::Warning)
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show()
            .await
            == rfd::MessageDialogResult::Ok
    }
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
    fn ticket_t_2_native_restore_excludes_restart_and_refuses_ready() {
        let gate = RecoveryGate::default();
        assert!(!gate.admit_restore(&CoreStatus::Ready {
            generation: "fixture".into(),
            pid: 1
        }));
        assert!(gate.admit_restore(&CoreStatus::Guarded));
        assert!(!gate.admit(&CoreStatus::Guarded));
        assert!(!gate.admit_restore(&CoreStatus::Guarded));
        gate.refused();
        assert!(gate.admit_restore(&CoreStatus::Failed));
    }

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
