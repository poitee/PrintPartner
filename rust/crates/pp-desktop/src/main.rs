use anyhow::{Context, Result, ensure};
use pp_core::{CoreHandle, CoreRuntime, CoreStatus};
use pp_desktop::{AllowedOrigin, ResourceLayout, desktop_data_dir, startup_diagnostic};
use std::path::PathBuf;
use tauri::{
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
};
mod recovery;

#[cfg(all(not(debug_assertions), feature = "desktop-e2e"))]
compile_error!("the desktop-e2e feature is not part of a release build");

#[cfg(feature = "desktop-e2e")]
static AUTOMATION_BUILD_MARKER: &str = "pp-desktop-e2e-marker-gre492";

#[cfg(feature = "desktop-e2e")]
fn automation_marker() -> &'static str {
    AUTOMATION_BUILD_MARKER
}

fn main() -> std::process::ExitCode {
    // Hold tracing rows and arm the crash hook before anything can log; rows
    // reach core.log once core startup admits the data directory. A failure
    // before that point is reported on stderr only.
    let core_log = pp_core::CoreLog::buffered();
    if !core_log.install() {
        eprintln!("core_log_unavailable: subscriber_already_installed");
    }
    match run(&core_log) {
        Ok(code) => std::process::ExitCode::from(code),
        Err(error) => {
            let diagnostic = startup_diagnostic(&error);
            tracing::error!("{diagnostic}");
            eprintln!("{diagnostic}");
            if cfg!(debug_assertions)
                && std::env::args().any(|argument| argument == "--test-exit-seconds")
            {
                return std::process::ExitCode::FAILURE;
            }
            show_startup_error();
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(feature = "desktop_rebuild")]
fn show_origin_notice(text: &str) {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let dialog = gtk::MessageDialog::builder()
            .title("Print Partner")
            .text(text)
            .message_type(gtk::MessageType::Info)
            .buttons(gtk::ButtonsType::Ok)
            .modal(true)
            .build();
        dialog.run();
        dialog.close();
    }
    #[cfg(not(target_os = "linux"))]
    {
        rfd::MessageDialog::new()
            .set_title("Print Partner")
            .set_description(text)
            .set_level(rfd::MessageLevel::Info)
            .show();
    }
}

fn show_startup_error() {
    let title = "Print Partner could not start";
    let description = "The desktop runtime or its verified resources could not start. Check that this installation is complete and that another Print Partner instance is not using its data directory.";
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        // Tauri initializes GTK on this thread and owns its main context. A
        // background dialog thread cannot acquire that context before run().
        // Run the modal GTK loop here, including failures before shell setup.
        if gtk::init().is_ok() {
            let dialog = gtk::MessageDialog::builder()
                .title(title)
                .text(title)
                .secondary_text(description)
                .message_type(gtk::MessageType::Error)
                .buttons(gtk::ButtonsType::Ok)
                .modal(true)
                .build();
            dialog.run();
            dialog.close();
        }
    }
    #[cfg(not(target_os = "linux"))]
    rfd::MessageDialog::new()
        .set_title(title)
        .set_description(description)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

fn run(core_log: &pp_core::CoreLog) -> Result<u8> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    tauri::async_runtime::set(runtime.handle().clone());
    #[cfg(feature = "desktop-e2e")]
    let builder = tauri::Builder::default().plugin(tauri_plugin_wdio_webdriver::init());
    #[cfg(not(feature = "desktop-e2e"))]
    let builder = tauri::Builder::default();
    #[cfg(feature = "desktop-e2e")]
    if std::env::var_os("PP_DESKTOP_E2E_MARKER").is_some() {
        println!("{}", automation_marker());
    }
    #[cfg(feature = "desktop_rebuild")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        pp_desktop::native_actions::open_sponsor,
        pp_desktop::origin_change::sync_portable_settings
    ]);
    let app = builder
        .build(tauri::generate_context!())
        .context("Native shell initialization failed")?;
    let mut args = std::env::args().skip(1);
    let mut stage = None;
    let mut data = None;
    let mut test_exit = None;
    let mut test_recovery_logs = false;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--dev-stage" if cfg!(debug_assertions) => {
                stage = Some(PathBuf::from(
                    args.next().context("Development stage missing")?,
                ))
            }
            "--data" if cfg!(debug_assertions) => {
                data = Some(PathBuf::from(
                    args.next().context("Development data directory missing")?,
                ))
            }
            "--test-exit-seconds" if cfg!(debug_assertions) => {
                test_exit = Some(
                    args.next()
                        .context("Test duration missing")?
                        .parse::<u64>()?,
                )
            }
            "--test-recovery-logs" if cfg!(debug_assertions) => test_recovery_logs = true,
            _ => anyhow::bail!("Unsupported desktop launch argument"),
        }
    }
    let stage = match stage {
        Some(stage) => stage,
        None => {
            let resources = app.path().resource_dir()?;
            if cfg!(target_os = "macos") {
                resources
                    .parent()
                    .context("App Contents unavailable")?
                    .to_owned()
            } else {
                resources.join("desktop-runtime")
            }
        }
    };
    let data = desktop_data_dir(data, || {
        app.path()
            .home_dir()
            .context("Desktop home directory unavailable")
    })?;
    let launch = ResourceLayout::read(&stage)
        .and_then(|layout| layout.into_launch(data.clone()))
        .context("Desktop resource verification failed")?;
    let probe_diagnostics = recovery::RecoveryUi::new(data.clone());
    let mut core = runtime
        .block_on(CoreRuntime::start(launch))
        .context("Desktop core startup failed")?;
    // Core startup admitted the data directory; flush the held rows and
    // record tracing and panics in its logs folder, telemetry or not.
    if let Err(error) = core_log.attach(&data) {
        eprintln!(
            "core_log_unavailable: os_error={}",
            error.raw_os_error().unwrap_or_default()
        );
    }
    let setup = (|| -> Result<_> {
        let origin = AllowedOrigin::parse(core.origin())?;
        let launch_url = core.take_launch_target()?.into_url();
        #[cfg(feature = "desktop_rebuild")]
        let (sponsor, origin_bridge) = {
            let enabled = core.desktop_rebuild().enabled();
            let sponsor = pp_desktop::native_actions::SponsorAction::from_startup(
                core.desktop_rebuild(),
                origin.clone(),
            );
            let origin_bridge = if enabled {
                pp_desktop::origin_change::require_fresh_bootstrap(
                    core.origin_change(),
                    &launch_url,
                )
                .context("Desktop core startup failed")?;
                let preferences = match runtime.block_on(core.handle().browser_preferences()) {
                    Ok(preferences) => Some(preferences),
                    Err(error) => {
                        eprintln!("{}", pp_desktop::browser_preferences_diagnostic(&error));
                        None
                    }
                };
                pp_desktop::origin_change::OriginBridge::enabled(
                    origin.clone(),
                    core.handle(),
                    preferences.as_ref(),
                    core.origin_change(),
                )
            } else {
                pp_desktop::origin_change::OriginBridge::disabled()
            };
            (sponsor, origin_bridge)
        };
        #[cfg(feature = "desktop_rebuild")]
        let origin_notice = origin_bridge.notice().map(str::to_owned);
        #[cfg(not(feature = "desktop_rebuild"))]
        let origin_notice: Option<String> = None;
        let url = launch_url.parse()?;
        #[cfg(feature = "desktop_rebuild")]
        if let Some(capability) = sponsor.capability() {
            app.add_capability(capability)?;
        }
        #[cfg(feature = "desktop_rebuild")]
        if let Some(capability) = origin_bridge.capability() {
            app.add_capability(capability)?;
        }
        let builder = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(url));
        #[cfg(feature = "desktop_rebuild")]
        let builder = {
            let builder = if let Some(script) = sponsor.initialization_script() {
                builder.initialization_script(script)
            } else {
                builder
            };
            let builder = if let Some(script) = origin_bridge.initialization_script() {
                builder.initialization_script(script)
            } else {
                builder
            };
            app.manage(sponsor);
            app.manage(origin_bridge);
            builder
        };
        let window = builder
            .title("Print Partner")
            .inner_size(1280.0, 850.0)
            .min_inner_size(900.0, 650.0)
            .on_navigation(move |url| origin.admits(url))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .build()
            .context("Native window initialization failed")?;
        let hide = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = hide.hide();
            }
        });
        let watch =
            build_tray(&app, core.handle(), data).context("Native tray initialization failed")?;
        Ok((window, watch, origin_notice))
    })();
    let (window, status_watch, origin_notice) = match setup {
        Ok(window) => window,
        Err(error) => {
            let receipt = runtime.block_on(core.shutdown());
            ensure!(receipt.complete(), "Desktop shutdown incomplete");
            return Err(error);
        }
    };
    #[cfg(feature = "desktop_rebuild")]
    let origin_notice_shown = std::sync::atomic::AtomicBool::new(false);
    let shutdown_requested = core.shutdown_requested();
    let app_handle = app.handle().clone();
    let stop_signal = runtime.spawn(async move {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
            _ = shutdown_requested => {},
            _ = tokio::signal::ctrl_c() => {},
            _ = async { if let Some(signal) = terminate.as_mut() { signal.recv().await; } else { std::future::pending::<()>().await; } } => {},
            _ = async { if let Some(seconds) = test_exit { tokio::time::sleep(std::time::Duration::from_secs(seconds)).await; } else { std::future::pending::<()>().await; } } => {},
        }
        app_handle.exit(0);
    });
    let exit_code = app.run_return(move |_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            status_watch.abort();
        }
        #[cfg(feature = "desktop_rebuild")]
        if matches!(event, tauri::RunEvent::Ready)
            && !origin_notice_shown.swap(true, std::sync::atomic::Ordering::AcqRel)
            && let Some(notice) = origin_notice.as_deref()
        {
            show_origin_notice(notice);
        }
        #[cfg(not(feature = "desktop_rebuild"))]
        let _ = &origin_notice;
        if cfg!(debug_assertions) && test_exit.is_some() && matches!(event, tauri::RunEvent::Ready) {
            if test_recovery_logs {
                probe_diagnostics.view_logs(_app);
            }
            let window = window.clone();
            let app = _app.clone();
            let _ = window.close();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let (send, receive) = tokio::sync::oneshot::channel();
                let show = window.clone();
                let _ = app.run_on_main_thread(move || {
                    let hidden = show.is_visible().is_ok_and(|visible| !visible);
                    let _ = show.show();
                    let _ = send.send(hidden);
                });
                let hidden = receive.await.unwrap_or(false);
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let _ = app.run_on_main_thread(move || {
                    let shown = window.is_visible().is_ok_and(|visible| visible);
                    println!("{}", serde_json::json!({"native_window": {"close_hid": hidden, "show_visible": shown}}));
                });
            });
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = (&window, &event);
    });
    stop_signal.abort();
    let receipt = runtime.block_on(core.shutdown());
    println!("{}", serde_json::to_string(&receipt)?);
    ensure!(receipt.complete(), "Desktop shutdown incomplete");
    Ok(u8::try_from(exit_code).unwrap_or(1))
}

fn build_tray(
    app: &tauri::App,
    handle: CoreHandle,
    data: PathBuf,
) -> Result<tauri::async_runtime::JoinHandle<()>> {
    let show = MenuItem::with_id(app, "show", "Show Print Partner", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Service ready", false, None::<&str>)?;
    let recover = MenuItem::with_id(app, "recover", "Restart service", false, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "View logs", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "data", "Open data folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Print Partner", true, None::<&str>)?;
    let recovery_ui = std::env::var("PP_DESKTOP_RECOVERY_UI").is_ok_and(|value| value == "1");
    let menu = if recovery_ui {
        Menu::with_items(app, &[&show, &status, &logs, &recover, &folder, &quit])?
    } else {
        Menu::with_items(app, &[&show, &status, &recover, &quit])?
    };
    let status_receiver = handle.subscribe();
    let recovery = handle.clone();
    let gate = std::sync::Arc::new(recovery::RecoveryGate::default());
    let recovery_gate = gate.clone();
    let diagnostics = recovery::RecoveryUi::new(data);
    TrayIconBuilder::with_id("printpartner")
        .icon(
            app.default_window_icon()
                .context("Desktop icon missing")?
                .clone(),
        )
        .tooltip("Print Partner")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "recover" => {
                recovery::restart(app, recovery.clone(), recovery_gate.clone());
            }
            "logs" if recovery_ui => diagnostics.view_logs(app),
            "data" if recovery_ui => diagnostics.open_data(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    let app_handle = app.handle().clone();
    let watch = tauri::async_runtime::spawn(async move {
        let mut receiver = status_receiver;
        loop {
            let state = receiver.borrow_and_update().clone();
            let text = match state {
                CoreStatus::Starting => "Service starting",
                CoreStatus::Ready { .. } => "Service ready",
                CoreStatus::Backoff { .. } => "Service reconnecting",
                CoreStatus::Guarded => "Service stopped after repeated failures",
                CoreStatus::Stopping => "Service stopping",
                CoreStatus::Stopped => "Service stopped",
                CoreStatus::Failed => "Service failed",
            };
            let guarded = gate.observe(&state);
            let (status, recover) = (status.clone(), recover.clone());
            if app_handle
                .run_on_main_thread(move || {
                    let _ = status.set_text(text);
                    let _ = recover.set_enabled(guarded);
                })
                .is_err()
            {
                break;
            }
            if receiver.changed().await.is_err() {
                break;
            }
        }
    });
    Ok(watch)
}

#[cfg(test)]
mod automation_boundary {
    #[test]
    fn desktop_e2e_is_opt_in() {
        const { assert!(!cfg!(feature = "desktop-e2e")) };
    }
}
