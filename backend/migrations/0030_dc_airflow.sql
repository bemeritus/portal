-- The airflow model (SPEC §14.2, PROMPT-AIRFLOW part A).
--
-- The API enqueues a run per room revision; `portal-cfd-worker`, a separate
-- process in its own container, claims it with FOR UPDATE SKIP LOCKED, runs
-- OpenFOAM, and writes progress and the result back here. This table is the
-- only link between the two: the API never talks to a container runtime.

CREATE TABLE dc_airflow_runs (
    id               BIGSERIAL PRIMARY KEY,
    room_id          BIGINT NOT NULL REFERENCES dc_rooms (id) ON DELETE CASCADE,
    revision         INTEGER NOT NULL,
    -- Everything the run depends on, derived from the revision (geometry,
    -- assumptions, numerical settings): the same input gives the same result.
    input            JSONB NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'done', 'not_converged', 'failed', 'cancelled')),
    -- Set by the API; the worker polls it and stops the solver.
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    -- {stage, iteration, iterations, residuals}, while running.
    progress         JSONB,
    -- Why a run is not a result: a code the UI translates. not_converged:
    -- residuals, residuals_growing, energy_balance, diverged, timeout;
    -- failed: mesh_failed, post_failed, bad_input, worker, processes_exceed_cpus
    -- (the run asks for more MPI processes than the worker has CPUs).
    reason           TEXT,
    -- What went wrong, for the log; never shown as a result.
    detail           TEXT,
    -- The numbers, each intake band as mean ± 95 % with an unstable flag, and
    -- the checks (also kept for a run that did not converge).
    summary          JSONB,
    -- Only for a run that converged: the browser grid (f16, gzipped) and the
    -- streamline sets (JSON, gzipped).
    grid             BYTEA,
    streamlines      BYTEA,
    worker           TEXT,
    requested_by     UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ,
    heartbeat_at     TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    CHECK (status <> 'done' OR (summary IS NOT NULL AND grid IS NOT NULL AND streamlines IS NOT NULL)),
    CHECK (status = 'done' OR (grid IS NULL AND streamlines IS NULL))
);

-- One job per revision at a time.
CREATE UNIQUE INDEX dc_airflow_runs_active
    ON dc_airflow_runs (room_id, revision) WHERE status IN ('queued', 'running');
-- The worker's queue.
CREATE INDEX dc_airflow_runs_queue
    ON dc_airflow_runs (created_at, id) WHERE status IN ('queued', 'running');
CREATE INDEX dc_airflow_runs_room ON dc_airflow_runs (room_id, id DESC);

-- Workers say they are alive; without a recent one the airflow mode says
-- the calculation is unavailable.
CREATE TABLE dc_airflow_workers (
    name      TEXT PRIMARY KEY,
    -- The solver image, by digest.
    image     TEXT NOT NULL,
    processes INTEGER NOT NULL,
    seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
