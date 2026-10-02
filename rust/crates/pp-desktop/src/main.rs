use anyhow::{Context, Result, ensure};
use pp_core::{CoreHandle, CoreRuntime, CoreStatus};
use pp_desktop::{AllowedOrigin, ResourceLayout};
use std::path::PathBuf;
use tauri::{
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
};

fn main() -> std::process::ExitCode {
    match run() {
        Ok(code) => std::process::ExitCode::from(code),
        Err(error) => {
            if cfg!(debug_assertions)
                && std::env::args().any(|argument| argument == "--test-exit-seconds")
            {
                eprintln!("{}", error);
                return std::process::ExitCode::FAILURE;
            }
            rfd::MessageDialog::new().set_title("Print Partner could not start")
                .set_description("The desktop runtime or its verified resources could not start. Check that this installation is complete and that another Print Partner instance is not using its data directory.")
                .set_level(rfd::MessageLevel::Error).show();
            std::process::ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u8> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    tauri::async_runtime::set(runtime.handle().clone());
    let app = tauri::Builder::default().build(tauri::generate_context!())?;
    let mut args = std::env::args().skip(1);
    let mut stage = None;
    let mut data = None;
    let mut test_exit = None;
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
    let data = data.unwrap_or(app.path().app_local_data_dir()?.join("core"));
    let launch = ResourceLayout::read(&stage)?.into_launch(data)?;
    let mut core = runtime.block_on(CoreRuntime::start(launch))?;
    let setup = (|| -> Result<_> {
        let origin = AllowedOrigin::parse(core.origin())?;
        let url = core.take_launch_target()?.into_url().parse()?;
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(url))
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
        let watch = build_tray(&app, core.handle()).context("Native tray initialization failed")?;
        Ok((window, watch))
    })();
    let (window, status_watch) = match setup {
        Ok(window) => window,
        Err(error) => {
            let receipt = runtime.block_on(core.shutdown());
            ensure!(receipt.complete(), "Desktop shutdown incomplete");
            return Err(error);
        }
    };
    let app_handle = app.handle().clone();
    let stop_signal = runtime.spawn(async move {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
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
        if cfg!(debug_assertions) && test_exit.is_some() && matches!(event, tauri::RunEvent::Ready) {
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
) -> Result<tauri::async_runtime::JoinHandle<()>> {
    let show = MenuItem::with_id(app, "show", "Show Print Partner", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Service ready", false, None::<&str>)?;
    let recover = MenuItem::with_id(app, "recover", "Restart service", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Print Partner", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &status, &recover, &quit])?;
    let status_receiver = handle.subscribe();
    let recovery = handle.clone();
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
                let handle = recovery.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle.recover_compat().await;
                });
            }
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
                CoreStatus::Stopped => "Service stopped",
            };
            let guarded = matches!(state, CoreStatus::Guarded);
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
