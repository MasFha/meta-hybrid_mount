// Copyright (C) 2026 YuzakiKokuban <heibanbaize@gmail.com>
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use std::{
    fs,
    io::{BufRead, BufReader, Error as IoError, ErrorKind, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Error, Result, bail};
use serde::Serialize;
use serde_json::{Value, json};
use signal_hook::{
    consts::signal::{SIGHUP, SIGINT, SIGTERM},
    flag,
};

use super::protocol::{DaemonCommand, DaemonRequest, DaemonResponse};
use crate::{
    conf::{
        config::Config,
        schema::{self},
    },
    core::{api, runtime_state::RuntimeState, user_hide_rules},
    defs,
    mount::kasumi as kasumi_mount,
    sys::{fs::atomic_write, kasumi, lkm},
};

pub fn serve(_config: Config) -> Result<()> {
    crate::utils::check_ksu();

    fs::create_dir_all(defs::RUN_DIR)
        .with_context(|| format!("Failed to create daemon run directory {}", defs::RUN_DIR))?;
    cleanup_stale_runtime_files()?;
    let listener = UnixListener::bind(defs::SOCKET_FILE)
        .with_context(|| format!("Failed to bind daemon socket {}", defs::SOCKET_FILE))?;
    fs::set_permissions(defs::SOCKET_FILE, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("Failed to set permissions on {}", defs::SOCKET_FILE))?;
    listener
        .set_nonblocking(true)
        .with_context(|| format!("Failed to set {} nonblocking", defs::SOCKET_FILE))?;
    let webui = WebuiHttpState::bind()?;
    let webui_session = webui.session();

    write_pid_file()?;
    let state = Arc::new(Mutex::new(RuntimeState::load().unwrap_or_default()));
    {
        let mut guard = state.lock().expect("daemon state poisoned");
        guard.set_daemon_state(true, defs::SOCKET_FILE);
        guard.save()?;
    }
    let _guard = DaemonRuntimeGuard::new(state.clone());
    let shutdown = install_shutdown_flag()?;

    let active_webui_connections = Arc::new(AtomicUsize::new(0));
    let sse_clients: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));

    crate::scoped_log!(
        info,
        "daemon",
        "listening: socket={}, webui={}",
        defs::SOCKET_FILE,
        webui.base_url()
    );

    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                if let Err(err) =
                    handle_stream(&state, &shutdown, &webui_session, &sse_clients, &mut stream)
                {
                    crate::scoped_log!(warn, "daemon", "request failed: error={:#}", err);
                    let payload = DaemonResponse::error(format!("{err:#}"));
                    let _ = write_response(&mut stream, &payload);
                }
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => {}
            Err(err) => {
                crate::scoped_log!(warn, "daemon", "accept failed: error={:#}", err);
            }
        }
        match webui.listener.accept() {
            Ok((mut stream, _addr)) => {
                let Some(connection_guard) =
                    ActiveWebuiConnectionGuard::try_acquire(&active_webui_connections)
                else {
                    let _ = write_http_json(
                        &mut stream,
                        503,
                        "Service Unavailable",
                        &DaemonResponse::error("too many active WebUI daemon connections"),
                        ConnectionAction::Close,
                    );
                    continue;
                };

                let state = state.clone();
                let shutdown = shutdown.clone();
                let session = webui_session.clone();
                let thread_sse = sse_clients.clone();
                let _ = std::thread::Builder::new()
                    .name("hybrid-mount-webui-rpc".to_string())
                    .spawn(move || {
                        let _connection_guard = connection_guard;
                        if let Err(err) =
                            handle_http_connection(&state, &shutdown, &session, thread_sse, stream)
                        {
                            crate::scoped_log!(
                                warn,
                                "daemon:http",
                                "request failed: error={:#}",
                                err
                            );
                        }
                    });
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => {}
            Err(err) => {
                crate::scoped_log!(warn, "daemon:http", "accept failed: error={:#}", err);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    crate::scoped_log!(
        info,
        "daemon",
        "shutdown requested: socket={}",
        defs::SOCKET_FILE
    );
    Ok(())
}

fn handle_stream(
    state: &Arc<Mutex<RuntimeState>>,
    shutdown: &Arc<AtomicBool>,
    webui: &WebuiHttpSession,
    sse_clients: &Arc<Mutex<Vec<TcpStream>>>,
    stream: &mut UnixStream,
) -> Result<()> {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .context("Failed to clone daemon stream")?,
    );
    let mut line = String::new();
    let bytes = reader
        .read_line(&mut line)
        .context("Failed to read daemon request")?;
    if bytes == 0 {
        bail!("daemon request was empty");
    }

    let request: DaemonRequest =
        serde_json::from_str(line.trim_end()).context("Failed to parse daemon request")?;
    let config_path = request
        .config_path
        .unwrap_or_else(|| PathBuf::from(defs::CONFIG_FILE));
    let effective_config = load_runtime_config(&config_path)?;
    let payload = dispatch_command(
        &effective_config,
        &config_path,
        state,
        shutdown,
        webui,
        sse_clients,
        request.command,
    )?;
    write_response(stream, &DaemonResponse::success(payload))
}

fn load_runtime_config(config_path: &Path) -> Result<Config> {
    Config::load_optional_from_file(config_path)
        .with_context(|| format!("Failed to load config from path: {}", config_path.display()))
}

struct WebuiHttpState {
    listener: TcpListener,
    session: WebuiHttpSession,
}

#[derive(Clone)]
struct WebuiHttpSession {
    addr: SocketAddr,
    token: String,
}

fn random_u64_hex() -> Result<String> {
    let mut buf = [0u8; 8];
    fs::File::open("/dev/urandom")
        .context("Failed to open /dev/urandom")?
        .read_exact(&mut buf)
        .context("Failed to read random bytes")?;
    Ok(format!("{:016x}", u64::from_ne_bytes(buf)))
}

impl WebuiHttpState {
    fn bind() -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .context("Failed to bind WebUI daemon HTTP listener")?;
        listener
            .set_nonblocking(true)
            .context("Failed to set WebUI daemon HTTP listener nonblocking")?;
        let addr = listener
            .local_addr()
            .context("Failed to read WebUI daemon HTTP listener address")?;
        let token = format!(
            "{}{}",
            random_u64_hex().context("Failed to generate daemon token")?,
            random_u64_hex().context("Failed to generate daemon token")?
        );
        Ok(Self {
            listener,
            session: WebuiHttpSession { addr, token },
        })
    }

    fn session(&self) -> WebuiHttpSession {
        self.session.clone()
    }

    fn base_url(&self) -> String {
        self.session.base_url()
    }
}

impl WebuiHttpSession {
    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn session_payload(&self) -> Value {
        json!({
            "base_url": self.base_url(),
            "token": self.token.clone(),
        })
    }
}

struct WebuiHttpRequest {
    request_line: String,
    authorized: bool,
    close_after_response: bool,
    body: Vec<u8>,
}

const MAX_WEBUI_HTTP_BODY_BYTES: usize = 1024 * 1024;
const MAX_WEBUI_CONNECTIONS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebuiHttpRequestReadError {
    InvalidContentLength,
    RequestBodyTooLarge,
}

impl WebuiHttpRequestReadError {
    fn status(self) -> (u16, &'static str, &'static str) {
        match self {
            Self::InvalidContentLength => (400, "Bad Request", "invalid content-length header"),
            Self::RequestBodyTooLarge => (413, "Payload Too Large", "request body too large"),
        }
    }
}

impl std::fmt::Display for WebuiHttpRequestReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (_, _, message) = self.status();
        f.write_str(message)
    }
}

impl std::error::Error for WebuiHttpRequestReadError {}

struct ActiveWebuiConnectionGuard {
    active_connections: Arc<AtomicUsize>,
}

impl ActiveWebuiConnectionGuard {
    fn try_acquire(active_connections: &Arc<AtomicUsize>) -> Option<Self> {
        loop {
            let current = active_connections.load(Ordering::Relaxed);
            if current >= MAX_WEBUI_CONNECTIONS {
                return None;
            }
            if active_connections
                .compare_exchange(current, current + 1, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return Some(Self {
                    active_connections: active_connections.clone(),
                });
            }
        }
    }
}

impl Drop for ActiveWebuiConnectionGuard {
    fn drop(&mut self) {
        self.active_connections.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConnectionAction {
    Keep,
    Close,
}

fn handle_http_connection(
    state: &Arc<Mutex<RuntimeState>>,
    shutdown: &Arc<AtomicBool>,
    webui: &WebuiHttpSession,
    sse_clients: Arc<Mutex<Vec<TcpStream>>>,
    mut stream: TcpStream,
) -> Result<()> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .context("Failed to set WebUI HTTP read timeout")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .context("Failed to set WebUI HTTP write timeout")?;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .context("Failed to clone WebUI HTTP stream")?,
    );

    while !shutdown.load(Ordering::Relaxed) {
        let request = match read_http_request(&mut reader, webui) {
            Ok(Some(request)) => request,
            Ok(None) => break,
            Err(err) => {
                if let Some(read_err) = err.downcast_ref::<WebuiHttpRequestReadError>() {
                    let (status, reason, message) = read_err.status();
                    let _ = write_http_json(
                        &mut stream,
                        status,
                        reason,
                        &DaemonResponse::error(message),
                        ConnectionAction::Close,
                    );
                    break;
                }
                return Err(err);
            }
        };
        if handle_http_request(state, shutdown, webui, &sse_clients, &mut stream, request)?
            == ConnectionAction::Close
        {
            break;
        }
    }

    Ok(())
}

fn read_http_request(
    reader: &mut BufReader<TcpStream>,
    webui: &WebuiHttpSession,
) -> Result<Option<WebuiHttpRequest>> {
    let mut request_line = String::new();
    let bytes = match reader.read_line(&mut request_line) {
        Ok(bytes) => bytes,
        Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
            return Ok(None);
        }
        Err(err) => return Err(err).context("Failed to read WebUI HTTP request line"),
    };
    if bytes == 0 {
        return Ok(None);
    }

    let mut content_length = 0usize;
    let mut authorized = false;
    let mut close_after_response = request_line.contains("HTTP/1.0");
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .context("Failed to read WebUI HTTP header")?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            if name == "content-length" {
                content_length = parse_content_length(value)?;
            } else if name == "authorization" {
                authorized = value == format!("Bearer {}", webui.token);
            } else if name == "connection" {
                for directive in value
                    .split(',')
                    .map(|item| item.trim().to_ascii_lowercase())
                {
                    if directive == "close" {
                        close_after_response = true;
                    } else if directive == "keep-alive" {
                        close_after_response = false;
                    }
                }
            }
        }
    }

    let mut body = allocate_request_body(content_length)?;
    std::io::Read::read_exact(reader, &mut body)
        .context("Failed to read WebUI HTTP request body")?;

    Ok(Some(WebuiHttpRequest {
        request_line,
        authorized,
        close_after_response,
        body,
    }))
}

fn parse_content_length(value: &str) -> Result<usize> {
    let content_length = value
        .parse::<usize>()
        .map_err(|_| Error::new(WebuiHttpRequestReadError::InvalidContentLength))?;
    if content_length > MAX_WEBUI_HTTP_BODY_BYTES {
        return Err(Error::new(WebuiHttpRequestReadError::RequestBodyTooLarge));
    }
    Ok(content_length)
}

fn allocate_request_body(content_length: usize) -> Result<Vec<u8>> {
    if content_length > MAX_WEBUI_HTTP_BODY_BYTES {
        return Err(Error::new(WebuiHttpRequestReadError::RequestBodyTooLarge));
    }
    Ok(vec![0; content_length])
}

fn handle_http_request(
    state: &Arc<Mutex<RuntimeState>>,
    shutdown: &Arc<AtomicBool>,
    webui: &WebuiHttpSession,
    sse_clients: &Arc<Mutex<Vec<TcpStream>>>,
    stream: &mut TcpStream,
    request: WebuiHttpRequest,
) -> Result<ConnectionAction> {
    let mut connection_action = if request.close_after_response || shutdown.load(Ordering::Relaxed)
    {
        ConnectionAction::Close
    } else {
        ConnectionAction::Keep
    };

    if request.request_line.starts_with("OPTIONS ") {
        write_http_response(stream, 204, "No Content", b"", connection_action)?;
        return Ok(ConnectionAction::Close);
    }
    if request.request_line.starts_with("GET /events ") {
        return handle_sse_endpoint(
            state,
            shutdown,
            webui,
            sse_clients,
            stream,
            &request.request_line,
        );
    }
    if !request.request_line.starts_with("POST /rpc ") {
        write_http_json(
            stream,
            404,
            "Not Found",
            &DaemonResponse::error("unknown WebUI daemon endpoint"),
            connection_action,
        )?;
        return Ok(ConnectionAction::Close);
    }
    if !request.authorized {
        write_http_json(
            stream,
            401,
            "Unauthorized",
            &DaemonResponse::error("invalid WebUI daemon token"),
            connection_action,
        )?;
        return Ok(ConnectionAction::Close);
    }

    let close_after_response = request.close_after_response;
    let request: DaemonRequest =
        serde_json::from_slice(&request.body).context("Failed to parse WebUI daemon request")?;
    let config_path = request
        .config_path
        .unwrap_or_else(|| PathBuf::from(defs::CONFIG_FILE));
    let effective_config = load_runtime_config(&config_path)?;
    let response = match dispatch_command(
        &effective_config,
        &config_path,
        state,
        shutdown,
        webui,
        sse_clients,
        request.command,
    ) {
        Ok(payload) => DaemonResponse::success(payload),
        Err(err) => DaemonResponse::error(format!("{err}")),
    };
    connection_action = if close_after_response || shutdown.load(Ordering::Relaxed) {
        ConnectionAction::Close
    } else {
        ConnectionAction::Keep
    };
    write_http_json(stream, 200, "OK", &response, connection_action)?;
    Ok(connection_action)
}

fn write_http_json(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    response: &DaemonResponse,
    connection_action: ConnectionAction,
) -> Result<()> {
    let body = serde_json::to_vec(response).context("Failed to serialize WebUI HTTP response")?;
    write_http_response(stream, status, reason, &body, connection_action)
}

fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &[u8],
    connection_action: ConnectionAction,
) -> Result<()> {
    let connection = if connection_action == ConnectionAction::Keep {
        "keep-alive"
    } else {
        "close"
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: authorization, content-type\r\n\
         Access-Control-Max-Age: 600\r\n\
         Connection: {connection}\r\n\
         Keep-Alive: timeout=30\r\n\r\n",
        body.len(),
    )
    .context("Failed to write WebUI HTTP response header")?;
    stream
        .write_all(body)
        .context("Failed to write WebUI HTTP response body")?;
    stream
        .flush()
        .context("Failed to flush WebUI HTTP response")
}

fn parse_query_param<'a>(request_line: &'a str, key: &str) -> Option<&'a str> {
    let path = request_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            return Some(v);
        }
    }
    None
}

fn handle_sse_endpoint(
    state: &Arc<Mutex<RuntimeState>>,
    shutdown: &Arc<AtomicBool>,
    webui: &WebuiHttpSession,
    sse_clients: &Arc<Mutex<Vec<TcpStream>>>,
    stream: &mut TcpStream,
    request_line: &str,
) -> Result<ConnectionAction> {
    let token = parse_query_param(request_line, "token").unwrap_or("");
    if token != webui.token {
        write_http_json(
            stream,
            401,
            "Unauthorized",
            &DaemonResponse::error("invalid SSE token"),
            ConnectionAction::Close,
        )?;
        return Ok(ConnectionAction::Close);
    }

    write!(
        stream,
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/event-stream\r\n\
         Cache-Control: no-cache\r\n\
         Connection: keep-alive\r\n\
         Access-Control-Allow-Origin: *\r\n\r\n"
    )
    .context("Failed to write SSE response header")?;
    stream.flush().context("Failed to flush SSE headers")?;

    // Send initial event
    let initial = {
        let mut guard = state.lock().expect("daemon state poisoned");
        serde_json::to_string(guard.status_value()?).unwrap_or_default()
    };
    write!(stream, "event: state_update\ndata: {initial}\n\n")
        .context("Failed to write SSE initial event")?;
    stream
        .flush()
        .context("Failed to flush SSE initial event")?;

    let sse_stream = stream
        .try_clone()
        .context("Failed to clone stream for SSE broadcast")?;
    {
        let mut clients = sse_clients.lock().expect("sse_clients poisoned");
        clients.push(sse_stream);
    }

    // Block until shutdown or client disconnect
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .context("Failed to set SSE read timeout")?;
    let mut buf = [0u8; 1];
    while !shutdown.load(Ordering::Relaxed) {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Err(ref e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                std::thread::sleep(Duration::from_secs(1));
            }
            Err(_) => break,
            _ => {}
        }
    }

    Ok(ConnectionAction::Close)
}

fn patch_config_file(config_path: &Path, patch: Value) -> Result<Config> {
    let config = load_runtime_config(config_path)?;
    let mut payload = serde_json::to_value(config).context("Failed to encode current config")?;
    merge_json(&mut payload, patch);

    let config: Config =
        serde_json::from_value(payload).context("Failed to decode patched config")?;
    config.save_to_file(config_path)?;
    Ok(config)
}

fn merge_json(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                match target.get_mut(&key) {
                    Some(existing) => merge_json(existing, value),
                    None => {
                        target.insert(key, value);
                    }
                }
            }
        }
        (target, patch) => {
            *target = patch;
        }
    }
}

fn read_kernel_uname_payload() -> Result<Value> {
    let release = fs::read_to_string("/proc/sys/kernel/osrelease")
        .context("failed to read /proc/sys/kernel/osrelease")?
        .trim()
        .to_string();
    let version = fs::read_to_string("/proc/sys/kernel/version")
        .context("failed to read /proc/sys/kernel/version")?
        .trim()
        .to_string();
    // NOTE: these proc reads may reflect spoofed values if Kasumi global uname
    // spoofing is active at the kernel UTS namespace level, not just the syscall.
    to_value(&json!({ "release": release, "version": version }))
}

fn open_url(url: &str) -> Result<()> {
    let status = Command::new("am")
        .arg("start")
        .arg("-a")
        .arg("android.intent.action.VIEW")
        .arg("-d")
        .arg(url)
        .status()
        .context("Failed to start Android VIEW intent")?;
    if !status.success() {
        bail!("am start exited with status {status}");
    }
    Ok(())
}

fn reboot_device() -> Result<()> {
    let status = Command::new("reboot")
        .status()
        .context("Failed to execute reboot")?;
    if !status.success() {
        bail!("reboot exited with status {status}");
    }
    Ok(())
}

fn add_kasumi_maps_config_rule(config_path: &Path, rule: Value) -> Result<Config> {
    let mut config = load_runtime_config(config_path)?;
    let rule: crate::conf::schema::KasumiMapsRuleConfig =
        serde_json::from_value(rule).context("Failed to decode Kasumi maps rule")?;
    config
        .kasumi
        .maps_rules
        .retain(|item| item.target_ino != rule.target_ino || item.target_dev != rule.target_dev);
    config.kasumi.maps_rules.push(rule);
    config.save_to_file(config_path)?;
    Ok(config)
}

fn dispatch_command(
    config: &Config,
    config_path: &Path,
    state: &Arc<Mutex<RuntimeState>>,
    shutdown: &Arc<AtomicBool>,
    webui: &WebuiHttpSession,
    sse_clients: &Arc<Mutex<Vec<TcpStream>>>,
    command: DaemonCommand,
) -> Result<Value> {
    match command {
        DaemonCommand::Ping => to_value(&json!({ "status": "ok" })),
        DaemonCommand::WebuiStart => Ok(webui.session_payload()),
        DaemonCommand::Init => {
            let mut guard = state.lock().expect("daemon state poisoned");
            let status_value = guard.status_value()?.clone();
            let config_value = to_value(config)?;
            let version_value = to_value(&api::build_version_payload())?;
            let kasumi_info = kasumi_mount::collect_runtime_info(config);
            let kasumi_status_value = to_value(&json!({
                "status": kasumi_info.status,
                "available": kasumi_info.available,
                "protocol_version": kasumi_info.protocol_version,
                "feature_bits": kasumi_info.feature_bits,
                "feature_names": kasumi_info.feature_names,
                "hooks": kasumi_info.hooks,
                "rule_count": kasumi_info.rule_count,
                "user_hide_rule_count": kasumi_info.user_hide_rule_count,
                "mirror_path": kasumi_info.mirror_path,
                "lkm": api::build_lkm_payload(config),
                "config": config.kasumi.clone(),
                "runtime": {
                    "snapshot": guard.kasumi,
                    "kasumi_modules": &guard.kasumi_modules,
                    "active_mounts": &guard.active_mounts,
                }
            }))?;
            to_value(&json!({
                "status": status_value,
                "config": config_value,
                "version": version_value,
                "kasumi_status": kasumi_status_value,
            }))
        }
        DaemonCommand::Shutdown => {
            shutdown.store(true, Ordering::Relaxed);
            to_value(&json!({ "shutdown": true }))
        }
        DaemonCommand::Status => {
            let mut guard = state.lock().expect("daemon state poisoned");
            Ok(guard.status_value()?.clone())
        }
        DaemonCommand::ApiStorage => {
            let guard = state.lock().expect("daemon state poisoned");
            to_value(&api::build_storage_payload(&guard))
        }
        DaemonCommand::ApiMountStats => {
            let guard = state.lock().expect("daemon state poisoned");
            to_value(&api::build_mount_stats_payload(&guard))
        }
        DaemonCommand::ApiMountTopology => {
            let guard = state.lock().expect("daemon state poisoned");
            to_value(&api::build_mount_topology_payload(config, &guard))
        }
        DaemonCommand::ApiPartitions => to_value(&api::build_partitions_payload(config)),
        DaemonCommand::ApiSystemInfo => {
            let guard = state.lock().expect("daemon state poisoned");
            to_value(&api::build_system_info_payload(&guard))
        }
        DaemonCommand::ApiVersion => to_value(&api::build_version_payload()),
        DaemonCommand::ApiConfigGet => to_value(config),
        DaemonCommand::ApiConfigSet { config: payload } => {
            let config: Config =
                serde_json::from_value(payload).context("Failed to decode config payload")?;
            config.save_to_file(config_path)?;
            refresh_and_to_value(
                &config,
                state,
                sse_clients,
                json!({ "saved": true, "config": &config }),
            )
        }
        DaemonCommand::ApiConfigPatch {
            patch,
            apply_runtime,
        } => {
            let config = patch_config_file(config_path, patch)?;
            let applied = if apply_runtime {
                let applied = kasumi_mount::apply_runtime_config(&config)?;
                kasumi::invalidate_status_cache();
                applied
            } else {
                false
            };
            refresh_and_to_value(
                &config,
                state,
                sse_clients,
                json!({
                    "saved": true,
                    "applied": applied,
                    "config": &config,
                }),
            )
        }
        DaemonCommand::ApiConfigReset => {
            let config = Config::default();
            config.save_to_file(config_path)?;
            kasumi_mount::apply_runtime_config(&config)?;
            kasumi::invalidate_status_cache();
            refresh_and_to_value(
                &config,
                state,
                sse_clients,
                json!({ "saved": true, "config": &config }),
            )
        }
        DaemonCommand::ApiModulesList { path } => {
            let snapshot = state.lock().expect("daemon state poisoned").clone();
            to_value(&api::build_modules_payload(
                config,
                &snapshot,
                path.as_deref(),
            )?)
        }
        DaemonCommand::ApiModulesApply { modules } => {
            let payload = api::apply_modules_payload(config_path, &modules)?;
            let config = load_runtime_config(config_path)?;
            refresh_and_to_value(&config, state, sse_clients, payload)
        }
        DaemonCommand::ApiLkm => to_value(&api::build_lkm_payload(config)),
        DaemonCommand::ApiHooks => {
            kasumi_mount::require_live(config, "read Kasumi hooks")?;
            to_value(&kasumi_mount::hook_lines()?)
        }
        DaemonCommand::ApiKernelUname => to_value(&read_kernel_uname_payload()?),
        DaemonCommand::ApiOpenUrl { url } => {
            open_url(&url)?;
            to_value(&json!({ "opened": true }))
        }
        DaemonCommand::ApiReboot => {
            reboot_device()?;
            to_value(&json!({ "reboot": true }))
        }
        DaemonCommand::ApiKasumiMapsAdd { rule } => {
            let updated = add_kasumi_maps_config_rule(config_path, rule)?;
            kasumi_mount::apply_runtime_config(&updated)?;
            kasumi::invalidate_status_cache();
            let count = updated.kasumi.maps_rules.len();
            refresh_and_to_value(
                &updated,
                state,
                sse_clients,
                json!({
                    "saved": true,
                    "config": &updated,
                    "count": count,
                }),
            )
        }
        DaemonCommand::ApiKasumiMapsClear => {
            let mut updated = load_runtime_config(config_path)?;
            updated.kasumi.maps_rules.clear();
            updated.save_to_file(config_path)?;
            kasumi_mount::apply_runtime_config(&updated)?;
            kasumi::invalidate_status_cache();
            refresh_and_to_value(
                &updated,
                state,
                sse_clients,
                json!({
                    "saved": true,
                    "config": &updated,
                    "count": 0,
                }),
            )
        }
        DaemonCommand::KasumiStatus => {
            let runtime_state = state.lock().expect("daemon state poisoned").clone();
            let kasumi_info = kasumi_mount::collect_runtime_info(config);
            to_value(&json!({
                "status": kasumi_info.status,
                "available": kasumi_info.available,
                "protocol_version": kasumi_info.protocol_version,
                "feature_bits": kasumi_info.feature_bits,
                "feature_names": kasumi_info.feature_names,
                "hooks": kasumi_info.hooks,
                "rule_count": kasumi_info.rule_count,
                "user_hide_rule_count": kasumi_info.user_hide_rule_count,
                "mirror_path": kasumi_info.mirror_path,
                "lkm": api::build_lkm_payload(config),
                "config": config.kasumi.clone(),
                "runtime": {
                    "snapshot": runtime_state.kasumi,
                    "kasumi_modules": runtime_state.kasumi_modules,
                    "active_mounts": runtime_state.active_mounts,
                }
            }))
        }
        DaemonCommand::KasumiList => {
            let payload = if kasumi_mount::can_operate(config) {
                api::parse_kasumi_rule_listing(&kasumi::list_rules()?)
            } else {
                Vec::new()
            };
            to_value(&payload)
        }
        DaemonCommand::KasumiVersion => {
            let guard = state.lock().expect("daemon state poisoned");
            to_value(&api::build_kasumi_version_payload(config, &guard))
        }
        DaemonCommand::KasumiFeatures => to_value(&api::build_features_payload()),
        DaemonCommand::KasumiHooks => to_value(&kasumi_mount::hook_lines()?),
        DaemonCommand::KasumiApplyConfigRuntime => {
            let applied = kasumi_mount::apply_runtime_config(config)?;
            kasumi::invalidate_status_cache();
            refresh_and_to_value(config, state, sse_clients, json!({ "applied": applied }))
        }
        DaemonCommand::HideList => to_value(&user_hide_rules::load_user_hide_rules()?),
        DaemonCommand::HideAdd { path } => {
            let added = user_hide_rules::add_user_hide_rule(&path)?;
            if added && kasumi_mount::can_operate(config) {
                kasumi::hide_path(&path)?;
            }
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "added": added, "path": path }),
            )
        }
        DaemonCommand::HideRemove { path } => {
            let removed = user_hide_rules::remove_user_hide_rule(&path)?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "removed": removed, "path": path }),
            )
        }
        DaemonCommand::HideApply => {
            kasumi_mount::require_live(config, "apply user hide rules")?;
            let (applied, failed) = user_hide_rules::apply_user_hide_rules()?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "applied": applied, "failed": failed }),
            )
        }
        DaemonCommand::LkmStatus => to_value(&api::build_lkm_payload(config)),
        DaemonCommand::LkmLoad => {
            lkm::load(&config.kasumi)?;
            kasumi::invalidate_status_cache();
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "message": "Kasumi LKM loaded." }),
            )
        }
        DaemonCommand::LkmUnload => {
            lkm::unload(&config.kasumi)?;
            kasumi::invalidate_status_cache();
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "message": "Kasumi LKM unloaded." }),
            )
        }
        DaemonCommand::KasumiClear => {
            kasumi::clear_rules()?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "message": "Kasumi rules cleared." }),
            )
        }
        DaemonCommand::KasumiReleaseConnection => {
            kasumi::release_connection();
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "message": "Released cached Kasumi client connection." }),
            )
        }
        DaemonCommand::KasumiInvalidateCache => {
            kasumi::invalidate_status_cache();
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "message": "Invalidated cached Kasumi status." }),
            )
        }
        DaemonCommand::KasumiFixMounts => {
            kasumi::fix_mounts()?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "message": "Kasumi mount ordering fixed." }),
            )
        }
        DaemonCommand::KasumiRestoreUnameGlobal => {
            kasumi::restore_uname_global()?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({ "message": "Kasumi global uname restored." }),
            )
        }
        DaemonCommand::KasumiSetUname {
            mode,
            release,
            version,
        } => {
            let mode = parse_uname_mode(&mode)?;
            apply_uname(mode, &release, &version)?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({
                    "message": "Kasumi uname applied.",
                    "mode": display_uname_mode(mode),
                    "release": release,
                    "version": version,
                }),
            )
        }
        DaemonCommand::KasumiClearUname { mode } => {
            let mode = parse_uname_mode(&mode)?;
            match mode {
                schema::KasumiUnameMode::Scoped => {
                    apply_uname(schema::KasumiUnameMode::Scoped, "", "")?
                }
                schema::KasumiUnameMode::Global => kasumi::restore_uname_global()?,
            }
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({
                    "message": "Kasumi uname cleared.",
                    "mode": display_uname_mode(mode),
                }),
            )
        }
        DaemonCommand::KasumiRuleAdd {
            target,
            source,
            file_type,
        } => {
            let file_type = file_type.unwrap_or(detect_rule_file_type(&source)?);
            kasumi::add_rule(&target, &source, file_type)?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({
                    "message": "Kasumi ADD rule applied.",
                    "target": target,
                    "source": source,
                    "file_type": file_type,
                }),
            )
        }
        DaemonCommand::KasumiRuleMerge { target, source } => {
            kasumi::add_merge_rule(&target, &source)?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({
                    "message": "Kasumi MERGE rule applied.",
                    "target": target,
                    "source": source,
                }),
            )
        }
        DaemonCommand::KasumiRuleHide { path } => {
            kasumi::hide_path(&path)?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({
                    "message": "Kasumi HIDE rule applied.",
                    "path": path,
                }),
            )
        }
        DaemonCommand::KasumiRuleDelete { path } => {
            kasumi::delete_rule(&path)?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({
                    "message": "Kasumi rule deleted.",
                    "path": path,
                }),
            )
        }
        DaemonCommand::KasumiRuleAddDir {
            target_base,
            source_dir,
        } => {
            kasumi::add_rules_from_directory(&target_base, &source_dir)?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({
                    "message": "Kasumi directory rules applied.",
                    "target_base": target_base,
                    "source_dir": source_dir,
                }),
            )
        }
        DaemonCommand::KasumiRuleRemoveDir {
            target_base,
            source_dir,
        } => {
            kasumi::remove_rules_from_directory(&target_base, &source_dir)?;
            refresh_and_to_value(
                config,
                state,
                sse_clients,
                json!({
                    "message": "Kasumi directory rules removed.",
                    "target_base": target_base,
                    "source_dir": source_dir,
                }),
            )
        }
        DaemonCommand::Batch { commands } => {
            let mut results: Vec<Value> = Vec::with_capacity(commands.len());
            for cmd in commands {
                let result = match dispatch_command(
                    config,
                    config_path,
                    state,
                    shutdown,
                    webui,
                    sse_clients,
                    cmd,
                ) {
                    Ok(value) => json!({ "ok": true, "data": value }),
                    Err(err) => json!({ "ok": false, "error": format!("{err}") }),
                };
                results.push(result);
            }
            to_value(&json!({ "results": results }))
        }
    }
}

fn write_response(stream: &mut UnixStream, response: &DaemonResponse) -> Result<()> {
    let serialized =
        serde_json::to_string(response).context("Failed to serialize daemon response")?;
    stream
        .write_all(serialized.as_bytes())
        .context("Failed to write daemon response")?;
    stream
        .write_all(b"\n")
        .context("Failed to terminate daemon response")?;
    stream.flush().context("Failed to flush daemon response")
}

fn cleanup_stale_runtime_files() -> Result<()> {
    cleanup_stale_pid_file()?;
    cleanup_stale_socket(Path::new(defs::SOCKET_FILE))?;
    mark_state_stopped_if_offline()?;
    Ok(())
}

fn cleanup_stale_socket(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    match UnixStream::connect(path) {
        Ok(_) => bail!("daemon socket already active at {}", path.display()),
        Err(_) => {
            fs::remove_file(path)
                .with_context(|| format!("Failed to remove stale socket {}", path.display()))?;
            Ok(())
        }
    }
}

fn cleanup_stale_pid_file() -> Result<()> {
    let Ok(raw) = fs::read_to_string(defs::PID_FILE) else {
        return Ok(());
    };
    let pid = raw.trim().parse::<i32>().ok();
    let Some(pid) = pid else {
        fs::remove_file(defs::PID_FILE)
            .with_context(|| format!("Failed to remove invalid pid file {}", defs::PID_FILE))?;
        return Ok(());
    };

    if !is_pid_process_alive(pid) {
        match fs::remove_file(defs::PID_FILE) {
            Ok(()) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err).with_context(|| {
                    format!("Failed to remove stale pid file {}", defs::PID_FILE)
                });
            }
        }
    }
    Ok(())
}

fn is_pid_process_alive(pid: i32) -> bool {
    let alive = unsafe { libc::kill(pid, 0) == 0 }
        || IoError::last_os_error().raw_os_error() == Some(libc::EPERM);
    if !alive {
        return false;
    }
    let cmdline_path = format!("/proc/{pid}/cmdline");
    match fs::read_to_string(&cmdline_path) {
        Ok(cmdline) => cmdline.contains("hybrid-mount"),
        Err(_) => true,
    }
}

fn mark_state_stopped_if_offline() -> Result<()> {
    let mut state = RuntimeState::load().unwrap_or_default();
    if !state.daemon.alive {
        return Ok(());
    }
    state.set_daemon_state(false, "");
    state.save()
}

fn write_pid_file() -> Result<()> {
    atomic_write(
        defs::PID_FILE,
        format!("{}\n", std::process::id()).as_bytes(),
    )
    .with_context(|| format!("Failed to write pid file {}", defs::PID_FILE))
}

fn refresh_and_to_value<T: Serialize>(
    config: &Config,
    state: &Arc<Mutex<RuntimeState>>,
    sse_clients: &Arc<Mutex<Vec<TcpStream>>>,
    payload: T,
) -> Result<Value> {
    refresh_runtime_snapshot(config, state, sse_clients)?;
    to_value(&payload)
}

fn refresh_runtime_snapshot(
    config: &Config,
    state: &Arc<Mutex<RuntimeState>>,
    sse_clients: &Arc<Mutex<Vec<TcpStream>>>,
) -> Result<()> {
    let mut guard = state.lock().expect("daemon state poisoned");
    guard.kasumi = kasumi_mount::collect_runtime_info(config);
    guard.set_daemon_state(true, defs::SOCKET_FILE);
    guard
        .status_value()
        .map_err(|e| anyhow::anyhow!("Failed to cache status value: {e}"))?;
    guard.save()?;
    drop(guard);
    broadcast_sse_event(state, sse_clients, "state_update");
    Ok(())
}

fn broadcast_sse_event(
    state: &Arc<Mutex<RuntimeState>>,
    sse_clients: &Arc<Mutex<Vec<TcpStream>>>,
    event: &str,
) {
    let json = {
        let mut guard = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.status_value() {
            Ok(v) => v.clone(),
            Err(_) => return,
        }
    };
    let body = match serde_json::to_string(&json) {
        Ok(s) => s,
        Err(_) => return,
    };
    let payload = format!("event: {event}\ndata: {body}\n\n");

    let mut clients = match sse_clients.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    clients.retain_mut(|client| {
        client
            .write_all(payload.as_bytes())
            .and_then(|_| client.flush())
            .is_ok()
    });
}

fn to_value<T: Serialize>(payload: &T) -> Result<Value> {
    serde_json::to_value(payload).context("Failed to encode daemon payload")
}

fn install_shutdown_flag() -> Result<Arc<AtomicBool>> {
    let shutdown = Arc::new(AtomicBool::new(false));
    flag::register(SIGTERM, shutdown.clone()).context("Failed to register SIGTERM handler")?;
    flag::register(SIGINT, shutdown.clone()).context("Failed to register SIGINT handler")?;
    flag::register(SIGHUP, shutdown.clone()).context("Failed to register SIGHUP handler")?;
    Ok(shutdown)
}

fn parse_uname_mode(mode: &str) -> Result<schema::KasumiUnameMode> {
    match mode {
        "scoped" => Ok(schema::KasumiUnameMode::Scoped),
        "global" => Ok(schema::KasumiUnameMode::Global),
        _ => bail!("invalid uname mode: {mode} (expected scoped or global)"),
    }
}

fn apply_uname(mode: schema::KasumiUnameMode, release: &str, version: &str) -> Result<()> {
    let mut uname = kasumi::KasumiSpoofUname::default();
    if !release.is_empty() {
        uname.set_release(release)?;
    }
    if !version.is_empty() {
        uname.set_version(version)?;
    }

    match mode {
        schema::KasumiUnameMode::Scoped => kasumi::set_uname(&uname),
        schema::KasumiUnameMode::Global => kasumi::set_uname_global(&uname),
    }
}

fn display_uname_mode(mode: schema::KasumiUnameMode) -> &'static str {
    match mode {
        schema::KasumiUnameMode::Scoped => "scoped",
        schema::KasumiUnameMode::Global => "global",
    }
}

fn detect_rule_file_type(path: &Path) -> Result<i32> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to read source metadata for {}", path.display()))?;
    let file_type = metadata.file_type();

    if file_type.is_char_device() && metadata.rdev() == 0 {
        bail!(
            "source {} is a whiteout node; use `kasumi rule hide` instead",
            path.display()
        );
    }

    if file_type.is_file() {
        Ok(libc::DT_REG as i32)
    } else if file_type.is_symlink() {
        Ok(libc::DT_LNK as i32)
    } else {
        bail!(
            "unsupported source type for rule add: {} (use `merge` or `add-dir` for directories)",
            path.display()
        )
    }
}

struct DaemonRuntimeGuard {
    state: Arc<Mutex<RuntimeState>>,
}

impl DaemonRuntimeGuard {
    fn new(state: Arc<Mutex<RuntimeState>>) -> Self {
        Self { state }
    }
}

impl Drop for DaemonRuntimeGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.lock() {
            guard.set_daemon_state(false, "");
            let _ = guard.save();
        }
        let _ = fs::remove_file(defs::PID_FILE);
        let _ = fs::remove_file(defs::SOCKET_FILE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_content_length_accepts_valid_value() {
        assert_eq!(parse_content_length("128").unwrap(), 128);
    }

    #[test]
    fn parse_content_length_rejects_invalid_value() {
        let err = parse_content_length("nope").unwrap_err();
        assert_eq!(
            err.downcast_ref::<WebuiHttpRequestReadError>(),
            Some(&WebuiHttpRequestReadError::InvalidContentLength)
        );
    }

    #[test]
    fn parse_content_length_rejects_oversized_value() {
        let err = parse_content_length(&(MAX_WEBUI_HTTP_BODY_BYTES + 1).to_string()).unwrap_err();
        assert_eq!(
            err.downcast_ref::<WebuiHttpRequestReadError>(),
            Some(&WebuiHttpRequestReadError::RequestBodyTooLarge)
        );
    }

    #[test]
    fn allocate_request_body_rejects_oversized_value() {
        let err = allocate_request_body(MAX_WEBUI_HTTP_BODY_BYTES + 1).unwrap_err();
        assert_eq!(
            err.downcast_ref::<WebuiHttpRequestReadError>(),
            Some(&WebuiHttpRequestReadError::RequestBodyTooLarge)
        );
    }

    #[test]
    fn connection_guard_tracks_active_connections() {
        let active_connections = Arc::new(AtomicUsize::new(0));
        {
            let _first = ActiveWebuiConnectionGuard::try_acquire(&active_connections).unwrap();
            assert_eq!(active_connections.load(Ordering::Relaxed), 1);
            let _second = ActiveWebuiConnectionGuard::try_acquire(&active_connections).unwrap();
            assert_eq!(active_connections.load(Ordering::Relaxed), 2);
        }
        assert_eq!(active_connections.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn connection_guard_enforces_connection_limit() {
        let active_connections = Arc::new(AtomicUsize::new(MAX_WEBUI_CONNECTIONS));
        assert!(ActiveWebuiConnectionGuard::try_acquire(&active_connections).is_none());
    }
}
