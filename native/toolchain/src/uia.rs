use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{cell::RefCell, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
use tokio_util::sync::CancellationToken;

pub async fn isolated(args: &Value, cancel: &CancellationToken) -> Result<Value> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--uia-worker")
        .env("DSH_ENV_FILE", "none")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut input = child.stdin.take().context("Missing UIA worker stdin")?;
    input.write_all(args.to_string().as_bytes()).await?;
    drop(input);
    let timeout = args["timeoutMs"].as_u64().unwrap_or(15000).clamp(1, 90000);
    let output = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(json!({"ok": false, "cancelled": true, "unknown": is_effect(args), "error": "UIA request cancelled"})),
        result = tokio::time::timeout(Duration::from_millis(timeout), child.wait_with_output()) => match result {
            Ok(output) => output?,
            Err(_) => return Ok(json!({"ok": false, "timeout": true, "unknown": is_effect(args), "error": "UIA worker timed out; no action was replayed"})),
        }
    };
    if !output.status.success() {
        bail!("UIA worker exited unexpectedly");
    }
    serde_json::from_slice(&output.stdout).context("Invalid UIA worker response")
}

fn is_effect(args: &Value) -> bool {
    !["state", "state-live", "read", "find", "windows"]
        .contains(&args["action"].as_str().unwrap_or("state"))
}

pub fn worker() -> Result<()> {
    let args: Value = serde_json::from_reader(std::io::stdin())?;
    let result = platform_execute(&args).unwrap_or_else(
        |error| json!({"ok": false, "error": error.to_string(), "unknown": is_effect(&args)}),
    );
    println!("{result}");
    Ok(())
}

pub async fn server() -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                output
                    .write_all(
                        json!({"id": null, "error": error.to_string()})
                            .to_string()
                            .as_bytes(),
                    )
                    .await?;
                output.write_all(b"\n").await?;
                output.flush().await?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let args = request.get("args").cloned().unwrap_or(request);
        let result = platform_execute(&args).unwrap_or_else(
            |error| json!({"ok": false, "error": error.to_string(), "unknown": is_effect(&args)}),
        );
        output
            .write_all(json!({"id": id, "result": result}).to_string().as_bytes())
            .await?;
        output.write_all(b"\n").await?;
        output.flush().await?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn platform_execute(_args: &Value) -> Result<Value> {
    Ok(
        json!({"ok": false, "unconfigured": true, "notExecuted": true, "error": "UI Automation requires Windows"}),
    )
}

#[cfg(windows)]
fn platform_execute(args: &Value) -> Result<Value> {
    windows_backend::execute(args)
}

#[cfg(windows)]
mod windows_backend {
    use super::*;
    use windows::{
        Win32::{
            Foundation::{CloseHandle, HANDLE, HWND, POINT},
            System::{
                Com::{
                    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                    CoUninitialize,
                },
                StationsAndDesktops::{
                    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
                    GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
                },
                Threading::{
                    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                    QueryFullProcessImageNameW,
                },
                Variant::VARIANT,
            },
            UI::{
                Accessibility::*,
                HiDpi::{
                    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
                },
                Input::KeyboardAndMouse::{
                    INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
                    MOUSEINPUT, SendInput,
                },
                WindowsAndMessaging::{
                    GetForegroundWindow, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
                    SetCursorPos, SetForegroundWindow,
                },
            },
        },
        core::{BSTR, Interface},
    };

    struct ComApartment;
    static DPI_AWARENESS: OnceLock<()> = OnceLock::new();

    fn ensure_dpi_awareness() {
        DPI_AWARENESS.get_or_init(|| unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        });
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    struct Session {
        _apartment: ComApartment,
        automation: IUIAutomation,
        cache: IUIAutomationCacheRequest,
        walker: IUIAutomationTreeWalker,
        windows: RefCell<std::collections::HashMap<i64, IUIAutomationElement>>,
        targets: RefCell<std::collections::HashMap<String, IUIAutomationElement>>,
    }

    impl Session {
        fn new() -> Result<Self> {
            unsafe {
                ensure_dpi_awareness();
                CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
                let apartment = ComApartment;
                let automation: IUIAutomation =
                    CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
                let cache = automation.CreateCacheRequest()?;
                cache.SetTreeScope(TreeScope_Element)?;
                for property in [
                    UIA_NamePropertyId,
                    UIA_AutomationIdPropertyId,
                    UIA_LocalizedControlTypePropertyId,
                    UIA_ControlTypePropertyId,
                    UIA_ProcessIdPropertyId,
                    UIA_IsEnabledPropertyId,
                    UIA_IsOffscreenPropertyId,
                    UIA_HasKeyboardFocusPropertyId,
                    UIA_IsPasswordPropertyId,
                    UIA_BoundingRectanglePropertyId,
                    UIA_ValueValuePropertyId,
                    UIA_SelectionItemIsSelectedPropertyId,
                    UIA_ScrollVerticalScrollPercentPropertyId,
                    UIA_ScrollHorizontalScrollPercentPropertyId,
                ] {
                    cache.AddProperty(property)?;
                }
                cache.AddPattern(UIA_ValuePatternId)?;
                cache.AddPattern(UIA_SelectionItemPatternId)?;
                cache.AddPattern(UIA_ScrollPatternId)?;
                let walker = automation.ControlViewWalker()?;
                Ok(Self {
                    _apartment: apartment,
                    automation,
                    cache,
                    walker,
                    windows: RefCell::new(std::collections::HashMap::new()),
                    targets: RefCell::new(std::collections::HashMap::new()),
                })
            }
        }
    }

    thread_local! {
        static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    }

    fn text(args: &Value, key: &str) -> String {
        args[key].as_str().unwrap_or("").to_string()
    }

    fn desktop_unlocked() -> Result<bool> {
        unsafe {
            let desktop = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)?;
            let mut buffer = [0u16; 256];
            let result = GetUserObjectInformationW(
                HANDLE(desktop.0),
                UOI_NAME,
                Some(buffer.as_mut_ptr().cast()),
                std::mem::size_of_val(&buffer) as u32,
                None,
            );
            let closed = CloseDesktop(desktop);
            result?;
            closed?;
            let end = buffer
                .iter()
                .position(|character| *character == 0)
                .unwrap_or(buffer.len());
            Ok(String::from_utf16_lossy(&buffer[..end]).eq_ignore_ascii_case("default"))
        }
    }

    fn process_matches(pid: u32, requested: &str) -> bool {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut buffer = vec![0u16; 32768];
            let mut length = buffer.len() as u32;
            let result = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut length,
            );
            let _ = CloseHandle(handle);
            if result.is_err() {
                return false;
            }
            let path = String::from_utf16_lossy(&buffer[..length as usize]);
            let actual = std::path::Path::new(&path)
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let expected = std::path::Path::new(requested)
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or(requested);
            actual.eq_ignore_ascii_case(expected)
        }
    }

    unsafe fn describe(element: &IUIAutomationElement) -> Result<Value> {
        unsafe {
            let password = element.CachedIsPassword()?.as_bool();
            let name = element.CachedName()?.to_string();
            let aid = element.CachedAutomationId()?.to_string();
            let identity = format!("{name} {aid}").to_lowercase();
            let sensitive = password
                || ["password", "token", "secret", "密码", "验证码", "口令"]
                    .iter()
                    .any(|term| identity.contains(term));
            let rect = element.CachedBoundingRectangle()?;
            let mut row = json!({"name": if password { "[redacted]".to_string() } else { name },
                "aid": aid, "type": element.CachedLocalizedControlType()?.to_string(),
                "controlType": element.CachedControlType()?.0, "pid": element.CachedProcessId()?,
                "enabled": element.CachedIsEnabled()?.as_bool(), "offscreen": element.CachedIsOffscreen()?.as_bool(),
                "focused": element.CachedHasKeyboardFocus()?.as_bool(), "password": password,
                "rect": {"x": rect.left, "y": rect.top, "w": rect.right - rect.left, "h": rect.bottom - rect.top}});
            if !sensitive
                && let Ok(pattern) = element.GetCachedPattern(UIA_ValuePatternId)
                && let Ok(value) = pattern.cast::<IUIAutomationValuePattern>()
            {
                match value.CachedValue() {
                    Ok(value) => row["value"] = json!(value.to_string()),
                    Err(_) => row["valueUnavailable"] = json!(true),
                }
            }
            if let Ok(pattern) = element.GetCachedPattern(UIA_SelectionItemPatternId)
                && let Ok(selection) = pattern.cast::<IUIAutomationSelectionItemPattern>()
                && let Ok(selected) = selection.CachedIsSelected()
            {
                row["selected"] = json!(selected.as_bool());
            }
            if let Ok(pattern) = element.GetCachedPattern(UIA_ScrollPatternId)
                && let Ok(scroll) = pattern.cast::<IUIAutomationScrollPattern>()
            {
                if let Ok(value) = scroll.CachedVerticalScrollPercent() {
                    row["verticalScrollPercent"] = json!(value);
                }
                if let Ok(value) = scroll.CachedHorizontalScrollPercent() {
                    row["horizontalScrollPercent"] = json!(value);
                }
            }
            Ok(row)
        }
    }

    fn line(row: &Value) -> String {
        format!(
            "{} | {} | aid={}{}",
            row["type"].as_str().unwrap_or(""),
            row["name"].as_str().unwrap_or(""),
            row["aid"].as_str().unwrap_or(""),
            row["value"]
                .as_str()
                .map(|value| format!(" | value={value}"))
                .unwrap_or_default()
        )
    }

    unsafe fn double_click(
        automation: &IUIAutomation,
        walker: &IUIAutomationTreeWalker,
        element: &IUIAutomationElement,
        handle: HWND,
    ) -> Result<Value> {
        unsafe {
            let _ = SetForegroundWindow(handle);
            std::thread::sleep(Duration::from_millis(80));
            if GetForegroundWindow() != handle {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": "Target window could not become foreground"}),
                );
            }
            let mut point = POINT::default();
            if !element.GetClickablePoint(&mut point)?.as_bool() {
                let rect = element.CurrentBoundingRectangle()?;
                if rect.right <= rect.left || rect.bottom <= rect.top {
                    return Ok(
                        json!({"ok": false, "notExecuted": true, "error": "Control has no clickable area"}),
                    );
                }
                point = POINT {
                    x: rect.left + (rect.right - rect.left) / 2,
                    y: rect.top + (rect.bottom - rect.top) / 2,
                };
            }
            let mut hit = automation.ElementFromPoint(point)?;
            let root_only = hit.CurrentControlType()? == UIA_WindowControlTypeId
                && hit.CurrentProcessId()? == element.CurrentProcessId()?;
            let hit_rect = hit.CurrentBoundingRectangle()?;
            let hit_test = json!({"point": {"x": point.x, "y": point.y}, "targetAid": element.CurrentAutomationId()?.to_string(),
                "actualAid": hit.CurrentAutomationId()?.to_string(), "actualType": hit.CurrentControlType()?.0,
                "actualPid": hit.CurrentProcessId()?, "actualRect": {"x": hit_rect.left, "y": hit_rect.top,
                    "w": hit_rect.right - hit_rect.left, "h": hit_rect.bottom - hit_rect.top}});
            let mut matches = false;
            for _depth in 0..16 {
                if automation.CompareElements(&hit, element)?.as_bool() {
                    matches = true;
                    break;
                }
                let Ok(parent) = walker.GetParentElement(&hit) else {
                    break;
                };
                hit = parent;
            }
            if !matches {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "hitTest": hit_test,
                        "errorCode": if root_only { "UIA_PROVIDER_ROOT_HIT" } else { "UIA_POINT_COVERED" },
                        "error": if root_only { "UIA provider resolved only the window, not the target control" } else { "Clickable point is covered by another control" }}),
                );
            }
            SetCursorPos(point.x, point.y)?;
            let down = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dwFlags: MOUSEEVENTF_LEFTDOWN,
                        ..Default::default()
                    },
                },
            };
            let up = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dwFlags: MOUSEEVENTF_LEFTUP,
                        ..Default::default()
                    },
                },
            };
            for click in 0..2 {
                if !desktop_unlocked()? || GetForegroundWindow() != handle {
                    return Ok(
                        json!({"ok": false, "notExecuted": click == 0, "unknown": click != 0, "error": "Input desktop or foreground changed"}),
                    );
                }
                if SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32) != 2 {
                    SendInput(&[up], std::mem::size_of::<INPUT>() as i32);
                    return Ok(
                        json!({"ok": false, "unknown": true, "error": "Mouse input was only partially accepted"}),
                    );
                }
                if click == 0 {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            std::thread::sleep(Duration::from_millis(80));
            let focused = element.CurrentHasKeyboardFocus()?.as_bool();
            Ok(
                json!({"ok": true, "action": "doubleclick", "output": "DOUBLECLICK", "inputEvents": 4,
                "focused": focused, "physicalPixels": true, "hitTestScope": "element"}),
            )
        }
    }

    unsafe fn scroll_element(
        walker: &IUIAutomationTreeWalker,
        element: &IUIAutomationElement,
        args: &Value,
    ) -> Result<Value> {
        unsafe {
            let direction = args["value"]
                .as_str()
                .filter(|value| !value.is_empty())
                .unwrap_or("down")
                .trim()
                .to_lowercase();
            if !["up", "down", "left", "right", "u", "d", "l", "r"].contains(&direction.as_str()) {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": "Scroll direction must be up/down/left/right"}),
                );
            }
            let horizontal = ["left", "right", "l", "r"].contains(&direction.as_str());
            let amount = if ["up", "left", "u", "l"].contains(&direction.as_str()) {
                ScrollAmount_LargeDecrement
            } else {
                ScrollAmount_LargeIncrement
            };
            let count = args["count"].as_i64().unwrap_or(1).clamp(1, 100);
            let mut current = element.clone();
            for _depth in 0..6 {
                if let Ok(pattern) = current
                    .GetCurrentPattern(UIA_ScrollPatternId)
                    .and_then(|pattern| pattern.cast::<IUIAutomationScrollPattern>())
                {
                    let before = json!({"vertical": pattern.CurrentVerticalScrollPercent()?, "horizontal": pattern.CurrentHorizontalScrollPercent()?});
                    for page in 0..count {
                        if !desktop_unlocked()? {
                            return Ok(
                                json!({"ok": false, "notExecuted": page == 0, "unknown": page != 0, "error": "Input desktop changed"}),
                            );
                        }
                        if horizontal {
                            pattern.Scroll(amount, ScrollAmount_NoAmount)?;
                        } else {
                            pattern.Scroll(ScrollAmount_NoAmount, amount)?;
                        }
                        std::thread::sleep(Duration::from_millis(60));
                    }
                    let after = json!({"vertical": pattern.CurrentVerticalScrollPercent()?, "horizontal": pattern.CurrentHorizontalScrollPercent()?});
                    return Ok(
                        json!({"ok": true, "action": "scroll", "output": format!("SCROLLED {direction} x{count}"), "scrollBefore": before, "scrollAfter": after}),
                    );
                }
                let Ok(parent) = walker.GetParentElement(&current) else {
                    break;
                };
                current = parent;
            }
            Ok(
                json!({"ok": false, "notExecuted": true, "error": "Control and its ancestors do not support ScrollPattern"}),
            )
        }
    }

    pub fn execute(args: &Value) -> Result<Value> {
        SESSION.with(|cell| {
            let mut session = cell.borrow_mut();
            if session.is_none() {
                *session = Some(Session::new()?);
            }
            unsafe { execute_once(args, session.as_ref().expect("UIA session initialized")) }
        })
    }

    unsafe fn execute_once(args: &Value, session: &Session) -> Result<Value> {
        let action = args["action"].as_str().unwrap_or("state");
        if ![
            "state",
            "state-live",
            "read",
            "find",
            "windows",
            "click",
            "setvalue",
            "pattern",
            "doubleclick",
            "scroll",
        ]
        .contains(&action)
        {
            return Ok(
                json!({"ok": false, "notExecuted": true, "error": "Unsupported native UIA action"}),
            );
        }
        if is_effect(args) && args["allowSideEffects"] != true {
            return Ok(
                json!({"ok": false, "notExecuted": true, "error": "allowSideEffects=true is required"}),
            );
        }
        for field in [
            "match",
            "inAid",
            "inName",
            "waitFor",
            "targetRef",
            "expectedRect",
        ] {
            if args
                .get(field)
                .is_some_and(|value| !value.is_null() && value != "")
            {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": format!("Native UIA does not implement {field}; select the legacy executor before dispatch")}),
                );
            }
        }
        unsafe {
            let automation = &session.automation;
            let cache = &session.cache;
            let walker = &session.walker;
            let requested_pid = args["procId"].as_u64().filter(|pid| *pid > 0);
            let requested_handle = args["winHandle"].as_i64().filter(|handle| *handle != 0);
            let process_name = text(args, "procName");
            let window_name = text(args, "winTitle");
            if requested_pid.is_none()
                && requested_handle.is_none()
                && process_name.is_empty()
                && window_name.is_empty()
            {
                return Ok(
                    json!({"ok": false, "unconfigured": true, "notExecuted": true, "error": "A target process or window is required"}),
                );
            }
            let mut windows = Vec::new();
            if let Some(expected_handle) = requested_handle {
                let handle = HWND(expected_handle as *mut std::ffi::c_void);
                if IsWindowVisible(handle).as_bool() {
                    let cached = session
                        .windows
                        .borrow()
                        .get(&expected_handle)
                        .and_then(|window| window.BuildUpdatedCache(cache).ok());
                    let candidate = cached
                        .or_else(|| automation.ElementFromHandleBuildCache(handle, cache).ok());
                    if let Some(candidate) = candidate {
                        let pid = candidate.CurrentProcessId()? as u32;
                        if requested_pid.is_none_or(|expected| expected == u64::from(pid))
                            && (requested_pid.is_some()
                                || process_name.is_empty()
                                || process_matches(pid, &process_name))
                            && (window_name.is_empty()
                                || candidate.CurrentName()?.to_string().contains(&window_name))
                        {
                            if session.windows.borrow().len() >= 32
                                && let Some(oldest) = session.windows.borrow().keys().next().cloned()
                            {
                                session.windows.borrow_mut().remove(&oldest);
                            }
                            session
                                .windows
                                .borrow_mut()
                                .insert(expected_handle, candidate.clone());
                            windows.push(candidate);
                        }
                    }
                }
            }
            if windows.is_empty() {
                let condition = automation.CreateTrueCondition()?;
                let root = automation.GetRootElement()?;
                let candidates = root.FindAll(TreeScope_Children, &condition)?;
                for index in 0..candidates.Length()? {
                    let candidate = candidates.GetElement(index)?;
                    let pid = candidate.CurrentProcessId()? as u32;
                    let handle = candidate.CurrentNativeWindowHandle()?;
                    if !IsWindowVisible(handle).as_bool() {
                        continue;
                    }
                    if requested_pid.is_some_and(|expected| expected != u64::from(pid)) {
                        continue;
                    }
                    if requested_handle.is_some_and(|expected| expected != handle.0 as i64) {
                        continue;
                    }
                    if requested_pid.is_none()
                        && !process_name.is_empty()
                        && !process_matches(pid, &process_name)
                    {
                        continue;
                    }
                    if !window_name.is_empty()
                        && !candidate.CurrentName()?.to_string().contains(&window_name)
                    {
                        continue;
                    }
                    if !handle.0.is_null() {
                        if session.windows.borrow().len() >= 32
                            && let Some(oldest) = session.windows.borrow().keys().next().cloned()
                        {
                            session.windows.borrow_mut().remove(&oldest);
                        }
                        session
                            .windows
                            .borrow_mut()
                            .insert(handle.0 as i64, candidate.clone());
                    }
                    windows.push(candidate);
                }
            }
            if action == "windows" {
                let mut lines = Vec::new();
                for window in &windows {
                    lines.push(format!(
                        "{} | pid={} | hwnd={}",
                        window.CurrentName()?,
                        window.CurrentProcessId()?,
                        window.CurrentNativeWindowHandle()?.0 as i64
                    ));
                }
                return Ok(
                    json!({"ok": true, "action": action, "count": lines.len(), "lines": lines, "scope": "visible top-level windows", "narrowed": true}),
                );
            }
            if windows.is_empty() {
                return Ok(
                    json!({"ok": false, "notFound": true, "notExecuted": true, "error": "Target window not found"}),
                );
            }
            if windows.len() != 1 {
                return Ok(
                    json!({"ok": false, "ambiguous": true, "notExecuted": true, "error": "Multiple windows match; specify winHandle", "count": windows.len()}),
                );
            }
            let window = &windows[0];
            let handle = window.CurrentNativeWindowHandle()?;
            let window_pid = window.CurrentProcessId()? as u32;
            let focused = automation
                .GetFocusedElement()
                .ok()
                .filter(|element| element.CurrentProcessId().ok() == Some(window_pid as i32))
                .and_then(|element| element.BuildUpdatedCache(cache).ok())
                .and_then(|element| describe(&element).ok());
            let secret_focused = focused.as_ref().map(|row| {
                let identity = format!(
                    "{} {}",
                    row["name"].as_str().unwrap_or(""),
                    row["aid"].as_str().unwrap_or("")
                )
                .to_lowercase();
                row["password"] == true
                    || ["password", "token", "secret", "密码", "验证码", "口令"]
                        .iter()
                        .any(|term| identity.contains(term))
            });
            let max = args["max"].as_u64().unwrap_or(100).clamp(1, 1000) as usize;
            let name = text(args, "name");
            let aid = text(args, "aid");
            let mut stack = vec![window.BuildUpdatedCache(cache)?];
            let mut selector_query = false;
            let selector_key = format!("{}|{}|{}", handle.0 as usize, name, aid);
            if (!name.is_empty() || !aid.is_empty())
                && (action == "find" || is_effect(args))
                && let Some(target) = session.targets.borrow().get(&selector_key).cloned()
                && let Ok(updated) = target.BuildUpdatedCache(cache)
                && updated.CurrentProcessId()? as u32 == window_pid
                && (aid.is_empty() || updated.CachedAutomationId()? == aid)
                && (name.is_empty() || updated.CachedName()? == name)
            {
                stack.clear();
                stack.push(updated);
                selector_query = true;
            }
            if !selector_query && (!name.is_empty() || !aid.is_empty()) {
                let mut selector = automation.ControlViewCondition()?;
                for (property, value) in [
                    (UIA_NamePropertyId, name.as_str()),
                    (UIA_AutomationIdPropertyId, aid.as_str()),
                ] {
                    if !value.is_empty() {
                        let condition =
                            automation.CreatePropertyCondition(property, &VARIANT::from(value))?;
                        selector = automation.CreateAndCondition(&selector, &condition)?;
                    }
                }
                if let Ok(selected) = window.FindAllBuildCache(TreeScope_Subtree, &selector, cache)
                {
                    stack.clear();
                    for index in (0..selected.Length()?.min(10001)).rev() {
                        stack.push(selected.GetElement(index)?);
                    }
                    selector_query = true;
                }
            }
            let mut matches = Vec::new();
            let mut rows = Vec::new();
            let mut scanned = 0usize;
            let mut skipped = 0usize;
            let mut truncated = false;
            let target_index = args["index"].as_u64().unwrap_or(0) as usize;
            while let Some(element) = stack.pop() {
                if scanned >= 10000 {
                    truncated = true;
                    break;
                }
                scanned += 1;
                if !selector_query
                    && let Ok(child) = walker.GetFirstChildElementBuildCache(&element, cache)
                {
                    let mut children = Vec::new();
                    let mut sibling = Some(child);
                    while let Some(next) = sibling {
                        if stack.len() + children.len() >= 10000 {
                            truncated = true;
                            break;
                        }
                        sibling = walker.GetNextSiblingElementBuildCache(&next, cache).ok();
                        children.push(next);
                    }
                    stack.extend(children.into_iter().rev());
                }
                if !aid.is_empty() && element.CachedAutomationId()? != aid {
                    continue;
                }
                if !name.is_empty() && element.CachedName()? != name {
                    continue;
                }
                match describe(&element) {
                    Ok(row) => {
                        if row["offscreen"] == true {
                            continue;
                        }
                        if !name.is_empty() && row["name"] != name {
                            continue;
                        }
                        if !aid.is_empty() && row["aid"] != aid {
                            continue;
                        }
                        if rows.len() >= max && !is_effect(args) && action != "find" {
                            truncated = true;
                            break;
                        }
                        matches.push(element);
                        rows.push(row);
                        if is_effect(args)
                            && args["requireUnique"] != true
                            && matches.len() > target_index
                        {
                            break;
                        }
                    }
                    Err(_) => skipped += 1,
                }
            }
            if (action == "find" || is_effect(args)) && matches.len() == 1 {
                if session.targets.borrow().len() >= 64
                    && let Some(oldest) = session.targets.borrow().keys().next().cloned()
                {
                    session.targets.borrow_mut().remove(&oldest);
                }
                session
                    .targets
                    .borrow_mut()
                    .insert(selector_key, matches[0].clone());
            }
            let lines: Vec<String> = rows.iter().map(line).collect();
            if action == "find" {
                return Ok(
                    json!({"ok": true, "action": action, "found": !matches.is_empty(), "count": matches.len(),
                    "detail": lines.first(), "truncated": truncated, "skipped": skipped, "scanned": scanned,
                    "scannedScope": if selector_query { "selector matches" } else { "control tree" }}),
                );
            }
            if !is_effect(args) {
                return Ok(
                    json!({"ok": true, "action": action, "window": window.CurrentName()?.to_string(),
                    "windowHandle": handle.0 as i64, "focused": focused.as_ref().map(line),
                    "focusedWindow": null, "secretFocused": secret_focused,
                    "count": rows.len(), "lines": lines, "controls": rows, "scanned": scanned, "skipped": skipped,
                    "truncated": truncated, "maxApplied": max, "returned": matches.len(), "narrowed": true,
                    "scope": if selector_query { "UIA selector matches in one visible window" } else { "UIA control view of one visible window" },
                    "scannedScope": if selector_query { "selector matches" } else { "control tree" }, "physicalPixels": true}),
                );
            }
            if name.is_empty() && aid.is_empty() {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": "An exact name or AutomationId is required"}),
                );
            }
            if truncated || skipped > 0 {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": "Incomplete UIA enumeration; target uniqueness is unknown"}),
                );
            }
            let index = args["index"].as_u64().unwrap_or(0) as usize;
            if matches.is_empty() {
                return Ok(
                    json!({"ok": false, "notFound": true, "notExecuted": true, "error": "Target control not found"}),
                );
            }
            if args["requireUnique"] == true && matches.len() != 1 {
                return Ok(
                    json!({"ok": false, "ambiguous": true, "notExecuted": true, "error": "Multiple controls match", "count": matches.len()}),
                );
            }
            let Some(element) = matches.get(index) else {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": "Control index is out of range"}),
                );
            };
            let mut current_pid = 0;
            GetWindowThreadProcessId(HWND(handle.0), Some(&mut current_pid));
            if !IsWindow(Some(handle)).as_bool()
                || current_pid != window_pid
                || element.CurrentProcessId()? as u32 != window_pid
            {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": "Target window identity changed"}),
                );
            }
            if !element.CurrentIsEnabled()?.as_bool() {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": "Target control is disabled"}),
                );
            }
            if element.CurrentIsOffscreen()?.as_bool() {
                return Ok(
                    json!({"ok": false, "notExecuted": true, "error": "Target control is offscreen"}),
                );
            }
            match desktop_unlocked() {
                Ok(true) => {}
                Ok(false) => {
                    return Ok(
                        json!({"ok": false, "notExecuted": true, "policyCode": "desktop_locked", "desktopState": "locked", "error": "Input desktop is locked"}),
                    );
                }
                Err(_) => {
                    return Ok(
                        json!({"ok": false, "notExecuted": true, "policyCode": "desktop_unknown", "desktopState": "unknown", "error": "Cannot verify the input desktop"}),
                    );
                }
            }
            if action == "doubleclick" {
                return double_click(automation, walker, element, handle);
            }
            if action == "scroll" {
                return scroll_element(walker, element, args);
            }
            if action == "setvalue" {
                let pattern: IUIAutomationValuePattern = match element
                    .GetCurrentPattern(UIA_ValuePatternId)
                    .and_then(|pattern| pattern.cast())
                {
                    Ok(pattern) => pattern,
                    Err(_) => {
                        return Ok(
                            json!({"ok": false, "notExecuted": true, "error": "ValuePattern is unavailable"}),
                        );
                    }
                };
                pattern.SetValue(&BSTR::from(text(args, "value")))?;
                let expected = args["expectValue"]
                    .as_str()
                    .unwrap_or_else(|| args["value"].as_str().unwrap_or(""));
                if pattern.CurrentValue()? != expected {
                    return Ok(
                        json!({"ok": false, "action": action, "error": "ValuePattern readback did not match the expected value"}),
                    );
                }
            } else {
                if let Ok(pattern) = element
                    .GetCurrentPattern(UIA_InvokePatternId)
                    .and_then(|pattern| pattern.cast::<IUIAutomationInvokePattern>())
                {
                    pattern.Invoke()?;
                } else if let Ok(pattern) = element
                    .GetCurrentPattern(UIA_TogglePatternId)
                    .and_then(|pattern| pattern.cast::<IUIAutomationTogglePattern>())
                {
                    pattern.Toggle()?;
                } else if let Ok(pattern) = element
                    .GetCurrentPattern(UIA_SelectionItemPatternId)
                    .and_then(|pattern| pattern.cast::<IUIAutomationSelectionItemPattern>())
                {
                    pattern.Select()?;
                } else {
                    return Ok(
                        json!({"ok": false, "notExecuted": true, "error": "Invoke, Toggle and SelectionItem patterns are unavailable"}),
                    );
                }
            }
            Ok(
                json!({"ok": true, "action": action, "output": "OK", "windowHandle": handle.0 as i64}),
            )
        }
    }
}
