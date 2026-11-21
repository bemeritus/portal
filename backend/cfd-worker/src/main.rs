//! `portal-cfd-worker`: runs the airflow model's jobs (SPEC §14.2).
//!
//! The API only enqueues runs in `dc_airflow_runs`; this process claims them
//! (`FOR UPDATE SKIP LOCKED`), runs OpenFOAM as child processes inside its
//! own container, and writes progress and the result back. The database is
//! the only link between the two: the API never talks to a container
//! runtime.
//!
//! ```text
//! portal-cfd-worker                              claim and run jobs until stopped
//! portal-cfd-worker run-case INPUT.json OUT_DIR  one case, no database
//! portal-cfd-worker reference-input              the reference case as JSON
//! ```
//!
//! Environment: `DATABASE_URL`; `CFD_WORK_DIR` (case directories, deleted
//! after each run); `CFD_PROCESSES` (MPI ranks, default: the CPUs this
//! process may use); `CFD_TIMEOUT_MIN` (120); `CFD_MAX_ITERATIONS` (4000:
//! how far a run whose checks fail is extended); `CFD_WORKER_NAME`;
//! `CFD_IMAGE` (the image digest, recorded with every result);
//! `FOAM_BASHRC`; `CFD_KEEP_CASE=1` keeps case directories.

mod db;
mod run;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use portal_cfd::input::CaseInput;
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use run::{Config, Monitor, Progress, Stop};

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn env_num<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

async fn config() -> Result<Config, String> {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
    let bashrc = env_or("FOAM_BASHRC", "/usr/lib/openfoam/openfoam2606/etc/bashrc");
    Ok(Config {
        work_dir: PathBuf::from(env_or("CFD_WORK_DIR", "/var/lib/portal-cfd")),
        processes: env_num("CFD_PROCESSES", cpus).max(1),
        timeout: Duration::from_secs(60 * env_num("CFD_TIMEOUT_MIN", 120u64)),
        max_iterations: env_num("CFD_MAX_ITERATIONS", 4000),
        image: env_or("CFD_IMAGE", "unknown"),
        env: run::foam_env(&bashrc).await?,
        keep_case: env_or("CFD_KEEP_CASE", "0") == "1",
    })
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(String::as_str) {
        Some("reference-input") => {
            let input = portal_cfd::reference::reference_input();
            println!(
                "{}",
                serde_json::to_string_pretty(&input).expect("serializable")
            );
            0
        }
        Some("run-case") if args.len() == 4 => run_case(&args[2], &args[3]).await,
        None => serve().await,
        _ => {
            eprintln!("usage: portal-cfd-worker [run-case INPUT.json OUT_DIR | reference-input]");
            2
        }
    };
    std::process::exit(code);
}

/// Progress to the log only.
struct LogMonitor(Instant);

impl Monitor for LogMonitor {
    async fn report(&mut self, p: &Progress) -> bool {
        if self.0.elapsed() > Duration::from_secs(30) {
            self.0 = Instant::now();
            tracing::info!(stage = p.stage, iteration = p.iteration, of = p.iterations, residuals = ?p.residuals);
        }
        true
    }
}

async fn run_case(input: &str, out: &str) -> i32 {
    let parsed = std::fs::read_to_string(input)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<CaseInput>(&s).map_err(|e| e.to_string()));
    let input = match parsed {
        Ok(i) => i,
        Err(e) => {
            eprintln!("{input}: {e}");
            return 2;
        }
    };
    let cfg = match config().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let out = PathBuf::from(out);
    if let Err(e) = std::fs::create_dir_all(&out) {
        eprintln!("{}: {e}", out.display());
        return 1;
    }
    match run::run(&cfg, &input, "run-case", LogMonitor(Instant::now())).await {
        Ok(o) => {
            let summary = serde_json::to_string_pretty(&o.summary).expect("serializable");
            let w = std::fs::write(out.join("summary.json"), summary)
                .and_then(|_| std::fs::write(out.join("grid.bin.gz"), &o.grid))
                .and_then(|_| std::fs::write(out.join("streamlines.json.gz"), &o.streamlines));
            if let Err(e) = w {
                eprintln!("{}: {e}", out.display());
                return 1;
            }
            match o.failure {
                None => {
                    println!("converged; result in {}", out.display());
                    0
                }
                Some(f) => {
                    println!("not converged ({f:?}); summary in {}", out.display());
                    3
                }
            }
        }
        Err(Stop::Failed { reason, detail }) => {
            eprintln!("failed ({reason}): {detail}");
            1
        }
        Err(Stop::TimedOut) => {
            eprintln!("timed out");
            1
        }
        Err(Stop::Cancelled) => 1,
    }
}

/// Progress to the database, at most every 5 s; also keeps the worker's
/// heartbeat fresh during a long run.
struct DbMonitor<'a> {
    pool: &'a PgPool,
    id: i64,
    cfg: &'a Config,
    worker: &'a str,
    last: Option<Instant>,
    going: bool,
}

impl Monitor for DbMonitor<'_> {
    async fn report(&mut self, p: &Progress) -> bool {
        if self
            .last
            .is_some_and(|t| t.elapsed() < Duration::from_secs(5))
        {
            return self.going;
        }
        self.last = Some(Instant::now());
        let v = serde_json::to_value(p).unwrap_or(Value::Null);
        match db::progress(self.pool, self.id, self.worker, &v).await {
            Ok(go) => self.going = go,
            Err(e) => tracing::warn!("progress of run {}: {e}", self.id),
        }
        let _ = db::heartbeat(
            self.pool,
            self.worker,
            &self.cfg.image,
            self.cfg.processes as i32,
        )
        .await;
        self.going
    }
}

async fn serve() -> i32 {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("DATABASE_URL is not set");
        return 2;
    };
    let cfg = match config().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let worker = env_or(
        "CFD_WORKER_NAME",
        std::fs::read_to_string("/etc/hostname")
            .unwrap_or_default()
            .trim(),
    );
    let worker = if worker.is_empty() {
        "cfd-worker".to_string()
    } else {
        worker
    };
    let pool = loop {
        match PgPoolOptions::new().max_connections(2).connect(&url).await {
            Ok(p) => break p,
            Err(e) => {
                tracing::warn!("database: {e}; retrying");
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    };
    tracing::info!(
        worker,
        processes = cfg.processes,
        image = cfg.image,
        "waiting for airflow runs"
    );
    let jobs = async {
        loop {
            if let Err(e) = db::heartbeat(&pool, &worker, &cfg.image, cfg.processes as i32).await {
                tracing::warn!("heartbeat: {e}");
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
            match db::claim(&pool, &worker).await {
                Ok(Some(job)) => handle(&pool, &cfg, &worker, job).await,
                Ok(None) => tokio::time::sleep(Duration::from_secs(5)).await,
                Err(e) => {
                    tracing::warn!("claiming a run: {e}");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            }
        }
    };
    let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("signals: {e}");
            return 1;
        }
    };
    tokio::select! {
        _ = jobs => 0,
        _ = tokio::signal::ctrl_c() => 0,
        _ = term.recv() => {
            // A run in progress is taken over by the next worker once its
            // heartbeat is stale.
            tracing::info!("stopping");
            0
        }
    }
}

async fn handle(pool: &PgPool, cfg: &Config, worker: &str, job: db::Claimed) {
    let id = job.id;
    tracing::info!(run = id, "run started");
    let input: CaseInput = match serde_json::from_value(job.input) {
        Ok(i) => i,
        Err(e) => {
            let detail = e.to_string();
            let f = db::Finish {
                status: "failed",
                reason: Some("bad_input"),
                detail: Some(&detail),
                summary: None,
                grid: None,
                streamlines: None,
            };
            if let Err(e) = db::finish(pool, id, worker, f).await {
                tracing::error!("run {id}: {e}");
            }
            return;
        }
    };
    let monitor = DbMonitor {
        pool,
        id,
        cfg,
        worker,
        last: None,
        going: true,
    };
    let outcome = run::run(cfg, &input, &format!("run-{id}"), monitor).await;
    let finish = match &outcome {
        Ok(o) => {
            let summary = serde_json::to_value(&o.summary).ok();
            match o.failure {
                None => db::Finish {
                    status: "done",
                    reason: None,
                    detail: None,
                    summary,
                    grid: Some(o.grid.clone()),
                    streamlines: Some(o.streamlines.clone()),
                },
                Some(f) => db::Finish {
                    status: "not_converged",
                    reason: Some(failure_code(f)),
                    detail: None,
                    summary,
                    grid: None,
                    streamlines: None,
                },
            }
        }
        Err(Stop::Cancelled) => db::Finish {
            status: "cancelled",
            reason: None,
            detail: None,
            summary: None,
            grid: None,
            streamlines: None,
        },
        Err(Stop::TimedOut) => db::Finish {
            status: "failed",
            reason: Some("timeout"),
            detail: None,
            summary: None,
            grid: None,
            streamlines: None,
        },
        Err(Stop::Failed { reason, detail }) => db::Finish {
            status: "failed",
            reason: Some(reason),
            detail: Some(detail),
            summary: None,
            grid: None,
            streamlines: None,
        },
    };
    tracing::info!(run = id, status = finish.status, reason = ?finish.reason, "run ended");
    if let Err(e) = db::finish(pool, id, worker, finish).await {
        tracing::error!("storing run {id}: {e}");
    }
}

fn failure_code(f: portal_cfd::checks::Failure) -> &'static str {
    use portal_cfd::checks::Failure::*;
    match f {
        Residuals => "residuals",
        EnergyBalance => "energy_balance",
        MassBalance => "mass_balance",
        IntakeDrift => "intake_drift",
    }
}
