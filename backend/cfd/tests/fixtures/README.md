# Fixtures: the port against the reference pipeline

The port's correctness is checked deterministically against the reference
scripts of `dc-handoff/reference/airflow-cfd/` (SPEC §14.2), separately from
the flow's unsteadiness.

- `case/` — what `make_case.py` + `bc.py` write for the reference case:
  every dictionary, the STL surfaces (gzipped), the `0/` fields after
  `bc.py`, and the meshed supply areas `bc.py` used (`bc_areas.json`).
  Checked by `../case_matches_reference.rs`.
- `post/` — solved fields of one run and what `post.py` makes of them:
  `cells.f32.gz` (cell centres, T, U as little-endian f32 after a u32
  count; only the cells within 0.35 m of a sampling point), `openings.json`
  (the averaged φ and T on each grille's faces), `input.json` (the run's
  input), `expected.json` (`post.py`'s summary, unrounded, plus the heat
  carried out through the grilles). Checked by `../post_matches_reference.rs`.

`gen/` holds the scripts that produced them, copies of the reference's:

- `make_case_mm.py` — `make_case.py` with its geometry in whole millimetres,
  rounded as `portal_cfd::reference::reference_input()` rounds it, so that both
  writers get the same input. From "STL writers" on it is `make_case.py`
  verbatim, except the grille rectangles, also rounded to whole millimetres.
- `bc.py`, `foamread.py`, `post.py` — copies, unchanged but for `post.py`'s
  rack label, in English here.
- `gen-case.sh` — runs `make_case_mm.py`, meshes a copy for `bc.py`'s grille
  areas, runs `bc.py`, collects `case/`.
- `gen_post.py`, `gen-post.sh` — from a kept run directory, writes `post/`
  and runs `post.py` with its rounding removed on exactly the kept values.

Both run in the pinned OpenFOAM image with `python3-numpy` and
`python3-scipy` added (a throwaway layer). The `post/` run was the reference
input with 200 mm background cells, 300 iterations and the mean of the last
100, on 12 processes:

```sh
# case/
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/fx -w /fx/gen \
  --entrypoint bash <image> gen-case.sh
# post/: a kept run (CFD_KEEP_CASE=1, CFD_WORK_DIR=$RUN) of such an input, then
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/fx -v "$RUN":/run -w /fx/gen \
  --entrypoint bash <image> gen-post.sh /run/run-case 300 /run/input.json
```
