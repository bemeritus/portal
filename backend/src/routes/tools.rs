//! `/api/tools` — small network utilities for the team.
//!
//! One tool so far: a TCP port check ("is 10.0.0.5:5432 reachable from the
//! server?"). It answers from *this server's* vantage point — which is the
//! point for an internal tool: the interesting question is almost always
//! whether the app host can reach something, not whether the internet can.
//!
//! Guard rails: the handler sits behind the session like everything else, the
//! target may not resolve to a loopback or unspecified address (probing the
//! server's own 127.0.0.1 services through the app would be a privilege the
//! web UI should not hand out), and the connect gets one short timeout — this
//! is a single-shot diagnostic, not a scanner.

use std::time::{Duration, Instant};

use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpStream, lookup_host};

use crate::auth::CurrentUser;
use crate::db::AppState;
use crate::error::{ApiError, ApiResult};

/// Patience for DNS and for the connect itself. Short: "no answer in four
/// seconds" *is* the diagnostic result (filtered or down), not a failure.
const TIMEOUT: Duration = Duration::from_secs(4);

pub fn routes() -> Router<AppState> {
    Router::new().route("/port-check", post(port_check))
}

#[derive(Deserialize)]
pub struct PortCheckBody {
    host: String,
    port: u16,
}

#[derive(Serialize)]
pub struct PortCheckResult {
    host: String,
    port: u16,
    /// The address actually dialled, for "it resolved to *what*?" moments.
    resolved_ip: String,
    /// What one TCP connect attempt came back with.
    ///
    /// `open` — the handshake completed; something is listening.
    /// `closed` — the host answered with a refusal; it is up, the port is not.
    /// `timeout` — no answer at all: host down, or a firewall dropping quietly.
    /// `unreachable` — the network said no route / unreachable.
    state: PortState,
    elapsed_ms: u64,
}

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PortState {
    Open,
    Closed,
    Timeout,
    Unreachable,
}

async fn port_check(
    CurrentUser(_user): CurrentUser,
    Json(body): Json<PortCheckBody>,
) -> ApiResult<Json<PortCheckResult>> {
    let host = body.host.trim().to_string();
    if host.is_empty() {
        return Err(ApiError::BadRequest("Host is required".into()));
    }
    // A pasted URL is the common slip; the fix is clearer than a DNS error.
    if host.contains('/') || host.contains(' ') || host.contains('@') {
        return Err(ApiError::BadRequest(
            "Enter a hostname or IP address, not a URL".into(),
        ));
    }
    if body.port == 0 {
        return Err(ApiError::BadRequest(
            "Port must be between 1 and 65535".into(),
        ));
    }

    // Resolve first, so the answer can say what was dialled — and so the
    // loopback guard sees through names like "localhost".
    let addrs: Vec<std::net::SocketAddr> =
        match tokio::time::timeout(TIMEOUT, lookup_host((host.as_str(), body.port))).await {
            Ok(Ok(addrs)) => addrs.collect(),
            Ok(Err(_)) => {
                return Err(ApiError::BadRequest(format!(
                    "'{host}' did not resolve — check the spelling"
                )));
            }
            Err(_) => {
                return Err(ApiError::BadRequest(format!(
                    "Resolving '{host}' timed out"
                )));
            }
        };
    let Some(addr) = addrs.first().copied() else {
        return Err(ApiError::BadRequest(format!(
            "'{host}' did not resolve to any address"
        )));
    };
    if addrs
        .iter()
        .any(|a| a.ip().is_loopback() || a.ip().is_unspecified())
    {
        return Err(ApiError::BadRequest(
            "Checking the server's own loopback addresses is not allowed".into(),
        ));
    }

    let started = Instant::now();
    let state = match tokio::time::timeout(TIMEOUT, TcpStream::connect(addr)).await {
        // The stream drops immediately: one handshake is the whole probe.
        Ok(Ok(_stream)) => PortState::Open,
        Ok(Err(e)) => match e.kind() {
            std::io::ErrorKind::ConnectionRefused => PortState::Closed,
            std::io::ErrorKind::TimedOut => PortState::Timeout,
            _ => PortState::Unreachable,
        },
        Err(_) => PortState::Timeout,
    };

    Ok(Json(PortCheckResult {
        host,
        port: body.port,
        resolved_ip: addr.ip().to_string(),
        state,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }))
}
