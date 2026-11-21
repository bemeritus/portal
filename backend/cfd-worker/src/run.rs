//! One run: the case written, meshed, solved and post-processed, with the
//! OpenFOAM tools as child processes. A port of the steps in
//! `reference/airflow-cfd/README.md`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use portal_cfd::case;
use portal_cfd::checks::{self, Checks, Opening, Residuals};
use portal_cfd::foam::{self, Mesh};
use portal_cfd::grid::{self, BROWSER_GRID_MM};
use portal_cfd::input::CaseInput;
use portal_cfd::post::{self, Fluctuation, Nearest, StreamSet};
use portal_cfd::summary::{Flow, Summary, Timings, VERSION};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// How the worker runs things; from its environment.
#[derive(Clone, Debug)]
pub struct Config {
    pub work_dir: PathBuf,
    /// CPUs this process may use (reported with the heartbeat; the MPI
    /// process count comes from each run's settings).
    pub cpus: usize,
    pub timeout: Duration,
    /// Iterations a run may be extended to while its checks fail.
    pub max_iterations: i32,
    pub image: String,
    /// The OpenFOAM environment, captured once from its `bashrc`.
    pub env: HashMap<String, String>,
    pub keep_case: bool,
}

/// What the job is doing, as stored in the run's `progress`.
#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub stage: &'static str,
    pub iteration: i32,
    pub iterations: i32,
    pub residuals: BTreeMap<String, f64>,
}

/// Told about progress every few seconds; answers whether to go on.
pub trait Monitor {
    fn report(&mut self, p: &Progress) -> impl Future<Output = bool> + Send;
}

pub enum Stop {
    Cancelled,
    TimedOut,
    /// A tool failed or a file could not be read: `reason` is a code the UI
    /// translates, `detail` is for the log.
    Failed {
        reason: &'static str,
        detail: String,
    },
}

pub struct Outcome {
    pub summary: Summary,
    /// `None` when the checks failed: such a run is not shown as a result.
    pub failure: Option<checks::Failure>,
    pub grid: Vec<u8>,
    pub streamlines: Vec<u8>,
}

fn failed(reason: &'static str, detail: impl Into<String>) -> Stop {
    Stop::Failed {
        reason,
        detail: detail.into(),
    }
}

/// The OpenFOAM environment: `bashrc` sourced once in a shell, its
/// variables kept for every child process.
pub async fn foam_env(bashrc: &str) -> Result<HashMap<String, String>, String> {
    let out = Command::new("bash")
        .arg("-c")
        .arg(format!(". '{bashrc}' >/dev/null 2>&1; env -0"))
        .output()
        .await
        .map_err(|e| format!("bash: {e}"))?;
    let env: HashMap<String, String> = out
        .stdout
        .split(|b| *b == 0)
        .filter_map(|kv| {
            let s = String::from_utf8_lossy(kv);
            s.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect();
    if !env.contains_key("WM_PROJECT_DIR") {
        return Err(format!("{bashrc} did not set up OpenFOAM"));
    }
    Ok(env)
}

struct Job<'a, M: Monitor> {
    cfg: &'a Config,
    input: &'a CaseInput,
    dir: PathBuf,
    monitor: M,
    started: Instant,
    residuals: Residuals,
    stage: &'static str,
    end: i32,
}

impl<M: Monitor> Job<'_, M> {
    fn progress(&self) -> Progress {
        Progress {
            stage: self.stage,
            iteration: self.residuals.iteration,
            iterations: self.end,
            residuals: self.residuals.latest(),
        }
    }

    /// Run a tool in the case directory; its output goes to `log.<name>`.
    /// The monitor is asked every few seconds; cancel and timeout kill the
    /// tool's whole process group.
    async fn tool(&mut self, name: &str, program: &str, args: &[String]) -> Result<(), Stop> {
        let log_path = self.dir.join(format!("log.{name}"));
        let mut log = tokio::fs::File::create(&log_path)
            .await
            .map_err(|e| failed("worker", format!("{}: {e}", log_path.display())))?;
        // One stream, in order: the solver writes its residuals to stderr.
        let mut child = Command::new("bash")
            .args(["-c", "exec \"$@\" 2>&1", "tool", program])
            .args(args)
            .current_dir(&self.dir)
            .env_clear()
            .envs(&self.cfg.env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| failed("worker", format!("{program}: {e}")))?;
        let pid = child.id();
        let mut lines = BufReader::new(child.stdout.take().expect("piped")).lines();
        let mut errs = BufReader::new(child.stderr.take().expect("piped")).lines();
        let mut tick = tokio::time::interval(Duration::from_secs(3));
        let parse = name.starts_with("solve");
        let mut stop = None;
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(l)) => {
                        if parse {
                            self.residuals.line(&l);
                        }
                        use tokio::io::AsyncWriteExt;
                        let _ = log.write_all(l.as_bytes()).await;
                        let _ = log.write_all(b"\n").await;
                    }
                    _ => break,
                },
                line = errs.next_line() => if let Ok(Some(l)) = line {
                    use tokio::io::AsyncWriteExt;
                    let _ = log.write_all(l.as_bytes()).await;
                    let _ = log.write_all(b"\n").await;
                },
                _ = tick.tick() => {
                    let p = self.progress();
                    if !self.monitor.report(&p).await {
                        stop = Some(Stop::Cancelled);
                    } else if self.started.elapsed() > self.cfg.timeout {
                        stop = Some(Stop::TimedOut);
                    }
                    if stop.is_some() {
                        break;
                    }
                }
            }
        }
        if let Some(s) = stop {
            if let Some(pid) = pid {
                // The tool and its MPI ranks: SIGTERM to the group, then kill.
                let _ = Command::new("kill")
                    .args(["-TERM", &format!("-{pid}")])
                    .status()
                    .await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            let _ = child.kill().await;
            return Err(s);
        }
        let status = child
            .wait()
            .await
            .map_err(|e| failed("worker", format!("{program}: {e}")))?;
        if !status.success() {
            let tail = tokio::fs::read_to_string(&log_path)
                .await
                .unwrap_or_default()
                .lines()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            let reason = if name.starts_with("solve") {
                "solver_failed"
            } else {
                "mesh_failed"
            };
            return Err(failed(
                reason,
                format!("{name} exited with {status}:\n{tail}"),
            ));
        }
        Ok(())
    }

    async fn foam(&mut self, name: &str, args: &[&str]) -> Result<(), Stop> {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let program = args[0].clone();
        self.tool(name, &program, &args[1..]).await
    }

    fn write(&self, rel: &str, text: &str) -> Result<(), Stop> {
        let p = self.dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| failed("worker", format!("{}: {e}", parent.display())))?;
        }
        std::fs::write(&p, text).map_err(|e| failed("worker", format!("{}: {e}", p.display())))
    }

    async fn solve(&mut self) -> Result<(), Stop> {
        let np = self.input.settings.processes.to_string();
        if self.input.settings.processes > 1 {
            self.tool(
                "solve",
                "mpirun",
                &[
                    "--oversubscribe".into(),
                    "-np".into(),
                    np,
                    "buoyantBoussinesqSimpleFoam".into(),
                    "-parallel".into(),
                ],
            )
            .await
        } else {
            self.foam("solve", &["buoyantBoussinesqSimpleFoam"]).await
        }
    }

    async fn reconstruct(&mut self, times: &[i32]) -> Result<(), Stop> {
        if self.input.settings.processes > 1 {
            let t: Vec<String> = times.iter().map(|t| t.to_string()).collect();
            let t = t.join(",");
            self.foam("reconstruct", &["reconstructPar", "-time", &t])
                .await?;
        }
        Ok(())
    }
}

fn read_err(e: String) -> Stop {
    failed("post_failed", e)
}

/// Mesh, solve and post-process `input` in `cfg.work_dir/name`.
pub async fn run<M: Monitor>(
    cfg: &Config,
    input: &CaseInput,
    name: &str,
    monitor: M,
) -> Result<Outcome, Stop> {
    input.validate().map_err(|e| failed("bad_input", e))?;
    let dir = cfg.work_dir.join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| failed("worker", format!("{}: {e}", dir.display())))?;
    let mut job = Job {
        cfg,
        input,
        dir: dir.clone(),
        monitor,
        started: Instant::now(),
        residuals: Residuals::default(),
        stage: "mesh",
        end: input.settings.iterations,
    };
    let result = pipeline(&mut job).await;
    if !cfg.keep_case {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

async fn pipeline<M: Monitor>(job: &mut Job<'_, M>) -> Result<Outcome, Stop> {
    let input = job.input;
    let mut timings = Timings::default();
    let t0 = Instant::now();
    for (rel, text) in case::files(input) {
        job.write(&rel, &text)?;
    }
    job.write(
        "system/decomposeParDict",
        &case::decompose_par_dict(input, input.settings.processes),
    )?;
    job.foam("blockMesh", &["blockMesh"]).await?;
    job.foam("snappyHexMesh", &["snappyHexMesh", "-overwrite"])
        .await?;
    job.foam("topoSet", &["topoSet"]).await?;
    job.foam("checkMesh", &["checkMesh"]).await?;
    let check = std::fs::read_to_string(job.dir.join("log.checkMesh")).unwrap_or_default();
    if !check.contains("Mesh OK.") {
        return Err(failed("mesh_failed", "checkMesh did not report Mesh OK"));
    }
    // The supply velocities from the grille areas as meshed (`bc.py`).
    let mesh = Mesh::read(&job.dir).map_err(read_err)?;
    let mut areas = BTreeMap::new();
    for u in &input.units {
        for k in 0..u.supplies.len() {
            let p = case::supply_patch(u, k);
            let a = mesh.patch_area(&p).ok_or_else(|| {
                failed(
                    "mesh_failed",
                    format!("no patch {p}: a grille is not in the mesh"),
                )
            })?;
            areas.insert(p, (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt());
        }
        for k in 0..u.returns.len() {
            let p = case::return_patch(u, k);
            if mesh.patches.get(&p).is_none_or(|&(_, n)| n == 0) {
                return Err(failed(
                    "mesh_failed",
                    format!("no patch {p}: a grille is not in the mesh"),
                ));
            }
        }
    }
    job.write("0/U", &case::u_field(input, &areas))?;
    if input.settings.processes > 1 {
        job.foam("decomposePar", &["decomposePar", "-force"])
            .await?;
    }
    timings.mesh = (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0;

    // Solve. While a band's mean is too uncertain, go on in steps of
    // EXTEND_STEP (the average carries on) up to the cap; a real failure
    // ends the run at once.
    let centres = mesh.cell_centres();
    let near = Nearest::for_case(input, &centres);
    let t1 = Instant::now();
    job.stage = "solve";
    let start = case::average_start(input);
    let (checks, mean_t, mean_u, fluct) = loop {
        job.solve().await?;
        let end = job.end;
        job.reconstruct(&[end]).await?;
        let (checks, t, u, fluct) = check_window(job, &mesh, start, end)?;
        let next = end + case::EXTEND_STEP;
        tracing::info!(
            end,
            failure = ?checks.failure(),
            half_width = checks.half_width_k.value,
            "window checked"
        );
        if checks.failure().is_some() || !checks.uncertain() || next > job.cfg.max_iterations {
            break (checks, t, u, fluct);
        }
        job.end = next;
        job.write("system/controlDict", &case::control_dict(input, next))?;
    };
    timings.solve = (t1.elapsed().as_secs_f64() * 10.0).round() / 10.0;

    job.stage = "post";
    let p = job.progress();
    job.monitor.report(&p).await;
    let t2 = Instant::now();
    let t_c: Vec<f64> = mean_t.iter().map(|t| t - 273.15).collect();
    let fine = post::resample(input, &near, &t_c, &mean_u, post::H);
    let numbers = post::numbers(input, &fine, &t_c, &mean_u, &fluct);
    let sets: Vec<StreamSet> = post::streamlines(input, &fine);
    drop(fine);
    let coarse = post::resample(input, &near, &t_c, &mean_u, BROWSER_GRID_MM as f64 / 1000.0);
    let grid_bytes = grid::encode(&coarse).map_err(read_err)?;
    let streamlines = grid::gzip(&serde_json::to_vec(&sets).map_err(|e| read_err(e.to_string()))?)
        .map_err(read_err)?;
    timings.post = (t2.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let failure = checks.failure();
    // At the cap a still uncertain band is part of the result, flagged.
    let unstable = if failure.is_none() {
        checks.wide.clone()
    } else {
        vec![]
    };
    let summary = Summary {
        version: VERSION,
        numbers,
        flow: Flow::PseudoSteady,
        iterations: job.end,
        checks,
        unstable,
        settings: input.settings.clone(),
        processes: input.settings.processes,
        image: job.cfg.image.clone(),
        solver: "buoyantBoussinesqSimpleFoam".into(),
        timings_s: timings,
        grid: grid::Header {
            n: coarse.n,
            h_mm: BROWSER_GRID_MM,
            fields: ["t", "ux", "uy", "uz"].map(String::from).to_vec(),
        },
        assumptions: input.assumptions.clone(),
    };
    Ok(Outcome {
        summary,
        failure,
        grid: grid_bytes,
        streamlines,
    })
}

/// The checks of the window `(start, end]`, the averaged T and U, and each
/// band's fluctuation and uncertainty.
#[allow(clippy::type_complexity)]
fn check_window<M: Monitor>(
    job: &Job<'_, M>,
    mesh: &Mesh,
    start: i32,
    end: i32,
) -> Result<(Checks, Vec<f64>, Vec<[f64; 3]>, Vec<[Fluctuation; 3]>), Stop> {
    let input = job.input;
    let at = job.dir.join(end.to_string());
    let t = foam::scalar_field(&at.join("TMean")).map_err(read_err)?;
    let u = foam::vector_field(&at.join("UMean")).map_err(read_err)?;
    let mut openings = vec![];
    for p in case::opening_patches(input) {
        let n = mesh.patches.get(&p).map_or(0, |&(_, n)| n);
        openings.push(Opening {
            phi: foam::patch_scalars(&at.join("phiMean"), &p, n).map_err(read_err)?,
            t: foam::patch_scalars(&at.join("TMean"), &p, n).map_err(read_err)?,
        });
    }
    let finite = t.iter().all(|v| v.is_finite()) && u.iter().flatten().all(|v| v.is_finite());
    let balance = if finite {
        checks::heat_removed(input, &openings)
    } else {
        (f64::NAN, f64::NAN)
    };
    let probes = read_probes(&job.dir).map_err(read_err)?;
    let fluct = checks::fluctuations(input, &probes, [start, end]);
    let checks = checks::evaluate(input, [start, end], &job.residuals, balance, &fluct);
    Ok((checks, t, u, fluct))
}

/// The intake probes of every solver run, in time order.
fn read_probes(dir: &Path) -> Result<Vec<(f64, Vec<f64>)>, String> {
    let base = dir.join("postProcessing/intakes");
    let mut starts: Vec<(f64, PathBuf)> = std::fs::read_dir(&base)
        .map_err(|e| format!("{}: {e}", base.display()))?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let t = e.file_name().to_string_lossy().parse::<f64>().ok()?;
            Some((t, e.path().join("T")))
        })
        .collect();
    starts.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut rows: Vec<(f64, Vec<f64>)> = vec![];
    for (_, f) in starts {
        let text = std::fs::read_to_string(&f).map_err(|e| format!("{}: {e}", f.display()))?;
        for r in checks::dat_rows(&text) {
            // A restart repeats nothing, but keep time order strict.
            if rows.last().is_none_or(|l| l.0 < r.0) {
                rows.push(r);
            }
        }
    }
    Ok(rows)
}
