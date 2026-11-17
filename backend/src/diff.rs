//! Text and block diffing for document history.
//!
//! Two revisions of a document are compared on two levels:
//!
//!   1. **Blocks** — the Q&A list is aligned by question text, so inserting a
//!      block at the top does not report every block below it as changed.
//!   2. **Lines** — within a matched pair, the answers are diffed line by line.
//!
//! Both levels use the same classic LCS (longest common subsequence) table.
//! That is `O(n·m)` in time and memory, which is the right trade here: a
//! document's answer is tens of lines, not a million, and the table version is
//! short enough to read and verify. The line count is capped all the same — see
//! `MAX_DIFF_LINES` — so a pathological paste degrades to "replaced wholesale"
//! instead of allocating a gigabyte.
//!
//! Nothing here renders Markdown: a diff shows the source the author typed,
//! which is what they need in order to see what changed.

use crate::models::{BlockDiff, DiffLine, RevisionBlock};

/// Above this many lines on either side, a changed answer is reported as a
/// wholesale replacement rather than diffed. Far above any real answer.
const MAX_DIFF_LINES: usize = 2000;

/// Unchanged lines kept either side of a change, as in a unified diff. Runs
/// longer than `2 * CONTEXT + 1` collapse into a single `skip` line.
const CONTEXT: usize = 3;

/// One step of an alignment between two sequences.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    /// Present in both, at these indices.
    Both(usize, usize),
    /// Only in the old sequence.
    Removed(usize),
    /// Only in the new sequence.
    Added(usize),
}

/// Align two sequences by LCS, returning the steps in sequence order.
///
/// Generic over the item so it serves both levels: lines of an answer and
/// questions of a document.
fn align<T: PartialEq>(old: &[T], new: &[T]) -> Vec<Step> {
    // table[i][j] = LCS length of old[i..] and new[j..]
    let mut table = vec![vec![0usize; new.len() + 1]; old.len() + 1];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i][j] = if old[i] == new[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }

    let mut steps = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < old.len() && j < new.len() {
        if old[i] == new[j] {
            steps.push(Step::Both(i, j));
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            steps.push(Step::Removed(i));
            i += 1;
        } else {
            steps.push(Step::Added(j));
            j += 1;
        }
    }
    while i < old.len() {
        steps.push(Step::Removed(i));
        i += 1;
    }
    while j < new.len() {
        steps.push(Step::Added(j));
        j += 1;
    }
    steps
}

/// A unified line diff of two texts, with long unchanged runs collapsed.
///
/// Returns an empty vector when the texts are identical, which the caller reads
/// as "nothing to show".
pub fn diff_text(old: &str, new: &str) -> Vec<DiffLine> {
    if old == new {
        return Vec::new();
    }

    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    // Too big to align: say so plainly rather than grinding through it.
    if old_lines.len() > MAX_DIFF_LINES || new_lines.len() > MAX_DIFF_LINES {
        let mut lines = Vec::with_capacity(2);
        lines.push(DiffLine::skip(old_lines.len()));
        lines.push(DiffLine::added(format!(
            "({} line(s) rewritten)",
            new_lines.len()
        )));
        return lines;
    }

    let steps = align(&old_lines, &new_lines);
    let full: Vec<DiffLine> = steps
        .iter()
        .map(|step| match *step {
            Step::Both(i, _) => DiffLine::context(old_lines[i].to_string()),
            Step::Removed(i) => DiffLine::removed(old_lines[i].to_string()),
            Step::Added(j) => DiffLine::added(new_lines[j].to_string()),
        })
        .collect();

    collapse_context(full)
}

/// Replace runs of unchanged lines longer than the context window with one
/// `skip` line, so a one-word fix in a long answer reads as a one-word fix.
fn collapse_context(lines: Vec<DiffLine>) -> Vec<DiffLine> {
    let changed: Vec<bool> = lines.iter().map(|l| l.kind != "context").collect();
    // A line survives if any change is within CONTEXT lines of it.
    let keep: Vec<bool> = (0..lines.len())
        .map(|i| {
            let from = i.saturating_sub(CONTEXT);
            let to = (i + CONTEXT + 1).min(lines.len());
            changed[from..to].iter().any(|c| *c)
        })
        .collect();

    let mut out: Vec<DiffLine> = Vec::new();
    let mut dropped = 0usize;
    for (line, keep) in lines.into_iter().zip(keep) {
        if keep {
            if dropped > 0 {
                out.push(DiffLine::skip(dropped));
                dropped = 0;
            }
            out.push(line);
        } else {
            dropped += 1;
        }
    }
    if dropped > 0 {
        out.push(DiffLine::skip(dropped));
    }
    out
}

/// How similar two blocks must be before an unmatched removal and an unmatched
/// addition are read as one block that was edited rather than as two unrelated
/// blocks. The same idea as a diff tool's rename detection, and the same
/// trade-off: too low and unrelated blocks get welded together, too high and a
/// rewritten question hides the answer's diff behind "removed, then added".
const PAIR_THRESHOLD: f32 = 0.5;

/// Hard cap on the pairing search inside one cluster of changes. Pairing is
/// quadratic in the cluster size, and a save that replaced forty blocks has
/// nothing useful to pair anyway.
const MAX_PAIR_CANDIDATES: usize = 24;

/// How a pair of revisions differ, block by block.
///
/// Blocks are first aligned on their question text (case- and space-insensitive),
/// which is what keeps an insertion from reporting every block below it as
/// changed. What the alignment cannot see is a block whose *question* was
/// rewritten: that looks like one block leaving and another arriving. So a
/// second pass walks each run of removals and additions and pairs the ones that
/// are similar enough — by answer text first, by question wording second — to
/// be the same block edited.
pub fn diff_blocks(old: &[RevisionBlock], new: &[RevisionBlock]) -> Vec<BlockDiff> {
    let old_keys: Vec<String> = old.iter().map(|b| key(&b.question)).collect();
    let new_keys: Vec<String> = new.iter().map(|b| key(&b.question)).collect();
    let steps = align(&old_keys, &new_keys);

    // old index -> new index for the pairs found below, and the reverse.
    let mut paired_old: Vec<Option<usize>> = vec![None; old.len()];
    let mut paired_new: Vec<Option<usize>> = vec![None; new.len()];
    for (removed, added) in clusters(&steps) {
        for (i, j) in pair_up(old, new, &removed, &added) {
            paired_old[i] = Some(j);
            paired_new[j] = Some(i);
        }
    }

    // Emit in the order the alignment walked, so the diff reads top to bottom
    // like the document. A pair is emitted at whichever of its two members
    // comes first and skipped at the other.
    let mut emitted: Vec<bool> = vec![false; old.len()];
    let mut out = Vec::new();
    for step in &steps {
        match *step {
            Step::Both(i, j) => out.push(BlockDiff::matched(&old[i], &new[j])),
            Step::Removed(i) => match paired_old[i] {
                Some(j) if !emitted[i] => {
                    emitted[i] = true;
                    out.push(BlockDiff::requestioned(&old[i], &new[j]));
                }
                Some(_) => {}
                None => out.push(BlockDiff::removed(&old[i])),
            },
            Step::Added(j) => match paired_new[j] {
                Some(i) if !emitted[i] => {
                    emitted[i] = true;
                    out.push(BlockDiff::requestioned(&old[i], &new[j]));
                }
                Some(_) => {}
                None => out.push(BlockDiff::added(&new[j])),
            },
        }
    }
    out
}

/// Split the alignment into runs of consecutive changes, each as the old and
/// new indices it touches. Pairing only happens within a run: blocks at
/// opposite ends of a document are not one edit, however alike they read.
fn clusters(steps: &[Step]) -> Vec<(Vec<usize>, Vec<usize>)> {
    let mut out = Vec::new();
    let mut removed = Vec::new();
    let mut added = Vec::new();
    for step in steps {
        match *step {
            Step::Removed(i) => removed.push(i),
            Step::Added(j) => added.push(j),
            Step::Both(..) => {
                if !removed.is_empty() && !added.is_empty() {
                    out.push((std::mem::take(&mut removed), std::mem::take(&mut added)));
                } else {
                    removed.clear();
                    added.clear();
                }
            }
        }
    }
    if !removed.is_empty() && !added.is_empty() {
        out.push((removed, added));
    }
    out
}

/// Greedily pair removals with additions, best match first. Greedy is enough
/// here: clusters are a handful of blocks, and the alternative (an optimal
/// assignment) would change the answer only in contrived cases.
fn pair_up(
    old: &[RevisionBlock],
    new: &[RevisionBlock],
    removed: &[usize],
    added: &[usize],
) -> Vec<(usize, usize)> {
    if removed.len() > MAX_PAIR_CANDIDATES || added.len() > MAX_PAIR_CANDIDATES {
        return Vec::new();
    }

    let mut candidates: Vec<(f32, usize, usize)> = Vec::new();
    for &i in removed {
        for &j in added {
            let score = similarity(&old[i], &new[j]);
            if score >= PAIR_THRESHOLD {
                candidates.push((score, i, j));
            }
        }
    }
    // Highest score first; ties by position, so the result does not depend on
    // the order the candidates happened to be generated in.
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));

    let mut pairs = Vec::new();
    let mut used_old: Vec<usize> = Vec::new();
    let mut used_new: Vec<usize> = Vec::new();
    for (_, i, j) in candidates {
        if used_old.contains(&i) || used_new.contains(&j) {
            continue;
        }
        used_old.push(i);
        used_new.push(j);
        pairs.push((i, j));
    }
    pairs
}

/// How alike two blocks are, in `0.0..=1.0`.
///
/// The stronger of two signals wins: an answer that survived a rewritten
/// question, or a question that survived a rewritten answer. Averaging them
/// would let one rewritten half hide the other half's evidence.
fn similarity(old: &RevisionBlock, new: &RevisionBlock) -> f32 {
    let answers = ratio(
        &old.answer.lines().collect::<Vec<_>>(),
        &new.answer.lines().collect::<Vec<_>>(),
    );
    let questions = ratio(
        &key(&old.question).split_whitespace().collect::<Vec<_>>(),
        &key(&new.question).split_whitespace().collect::<Vec<_>>(),
    );
    answers.max(questions)
}

/// The share of two sequences that is common to both: `2·|LCS| / (|a| + |b|)`.
fn ratio<T: PartialEq>(old: &[T], new: &[T]) -> f32 {
    if old.is_empty() && new.is_empty() {
        return 1.0;
    }
    let common = align(old, new)
        .iter()
        .filter(|step| matches!(step, Step::Both(..)))
        .count();
    2.0 * common as f32 / (old.len() + new.len()) as f32
}

/// The identity of a block for matching purposes: its question, with case and
/// surrounding space ignored so a capitalisation fix is an edit, not a swap.
fn key(question: &str) -> String {
    question.trim().to_lowercase()
}

/// How many blocks a diff adds, removes and edits — the history list's summary.
///
/// Counts rather than a sentence: only the client knows which language to say
/// "2 blocks edited" in.
pub fn count_changes(diffs: &[BlockDiff]) -> (i64, i64, i64) {
    let count = |kind: &str| diffs.iter().filter(|d| d.kind == kind).count() as i64;
    (count("added"), count("removed"), count("changed"))
}

// The constructors live here rather than in `models`, which stays plain data:
// building a `BlockDiff` means running a line diff, and that is this module's
// job.

impl DiffLine {
    fn of(kind: &str, text: String) -> Self {
        Self {
            kind: kind.to_string(),
            text,
        }
    }

    pub fn context(text: String) -> Self {
        Self::of("context", text)
    }

    pub fn added(text: String) -> Self {
        Self::of("added", text)
    }

    pub fn removed(text: String) -> Self {
        Self::of("removed", text)
    }

    /// A fold marker standing in for `count` unchanged lines. The text is the
    /// bare number: the client words it in the reader's language.
    pub fn skip(count: usize) -> Self {
        Self::of("skip", count.to_string())
    }
}

impl BlockDiff {
    /// Two blocks the alignment paired by question.
    fn matched(old: &RevisionBlock, new: &RevisionBlock) -> Self {
        let lines = diff_text(&old.answer, &new.answer);
        // Matching ignores case and surrounding space, so a paired block can
        // still have had its wording touched — that is a change, and the old
        // wording is worth showing even when the answer stood still.
        let requestioned = old.question != new.question;
        Self {
            kind: if lines.is_empty() && !requestioned {
                "unchanged".into()
            } else {
                "changed".into()
            },
            question: new.question.clone(),
            question_old: requestioned.then(|| old.question.clone()),
            lines,
        }
    }

    /// One block whose question *and* answer were rewritten — an edit the
    /// alignment could only see as a removal next to an addition.
    fn requestioned(old: &RevisionBlock, new: &RevisionBlock) -> Self {
        Self {
            kind: "changed".into(),
            question: new.question.clone(),
            question_old: Some(old.question.clone()),
            lines: diff_text(&old.answer, &new.answer),
        }
    }

    fn added(new: &RevisionBlock) -> Self {
        Self {
            kind: "added".into(),
            question: new.question.clone(),
            question_old: None,
            lines: new
                .answer
                .lines()
                .map(|l| DiffLine::added(l.to_string()))
                .collect(),
        }
    }

    fn removed(old: &RevisionBlock) -> Self {
        Self {
            kind: "removed".into(),
            question: old.question.clone(),
            question_old: None,
            lines: old
                .answer
                .lines()
                .map(|l| DiffLine::removed(l.to_string()))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(question: &str, answer: &str) -> RevisionBlock {
        RevisionBlock {
            question: question.into(),
            answer: answer.into(),
        }
    }

    #[test]
    fn identical_text_has_no_diff() {
        assert!(diff_text("same\nlines", "same\nlines").is_empty());
    }

    #[test]
    fn changed_line_is_a_removal_and_an_addition() {
        let lines = diff_text("one\ntwo\nthree", "one\nTWO\nthree");
        let kinds: Vec<&str> = lines.iter().map(|l| l.kind.as_str()).collect();
        assert_eq!(kinds, ["context", "removed", "added", "context"]);
        assert_eq!(lines[1].text, "two");
        assert_eq!(lines[2].text, "TWO");
    }

    #[test]
    fn long_unchanged_runs_collapse() {
        let old: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        let new = old.replace("line 15", "line fifteen");
        let lines = diff_text(&old, &new);
        // Two skips (before and after), six context lines, one change pair.
        assert_eq!(lines.iter().filter(|l| l.kind == "skip").count(), 2);
        assert_eq!(lines.iter().filter(|l| l.kind == "context").count(), 6);
        assert!(
            lines
                .iter()
                .any(|l| l.kind == "removed" && l.text == "line 15")
        );
        assert!(
            lines
                .iter()
                .any(|l| l.kind == "added" && l.text == "line fifteen")
        );
    }

    #[test]
    fn inserted_block_leaves_its_neighbours_unchanged() {
        let old = [block("A", "a"), block("B", "b")];
        let new = [block("A", "a"), block("New", "n"), block("B", "b")];
        let diffs = diff_blocks(&old, &new);
        let kinds: Vec<&str> = diffs.iter().map(|d| d.kind.as_str()).collect();
        assert_eq!(kinds, ["unchanged", "added", "unchanged"]);
    }

    #[test]
    fn edited_answer_is_reported_as_changed() {
        let old = [block("A", "first\nsecond")];
        let new = [block("A", "first\nsecond edited")];
        let diffs = diff_blocks(&old, &new);
        assert_eq!(diffs[0].kind, "changed");
        assert!(diffs[0].question_old.is_none());
        assert!(!diffs[0].lines.is_empty());
    }

    #[test]
    fn edited_question_keeps_the_block_and_its_answer_diff() {
        let old = [block("Old question?", "body")];
        let new = [block("New question?", "body rewritten")];
        let diffs = diff_blocks(&old, &new);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].kind, "changed");
        assert_eq!(diffs[0].question_old.as_deref(), Some("Old question?"));
        assert!(!diffs[0].lines.is_empty());
    }

    #[test]
    fn a_reworded_question_pairs_with_its_own_block_not_a_neighbour() {
        // The first block's question is rewritten and the second is deleted.
        // Only the answers say which is which — and they must be believed.
        let old = [block("First?", "kept body"), block("Second?", "other body")];
        let new = [block("First, rewritten?", "kept body")];
        let diffs = diff_blocks(&old, &new);
        let kinds: Vec<&str> = diffs.iter().map(|d| d.kind.as_str()).collect();
        assert_eq!(kinds, ["changed", "removed"]);
        assert_eq!(diffs[0].question_old.as_deref(), Some("First?"));
        assert_eq!(diffs[1].question, "Second?");
    }

    #[test]
    fn unrelated_blocks_are_not_welded_into_one_edit() {
        let old = [block("How do I rotate logs?", "logrotate")];
        let new = [block("Where is the backup script?", "/srv/backup.sh")];
        let diffs = diff_blocks(&old, &new);
        let kinds: Vec<&str> = diffs.iter().map(|d| d.kind.as_str()).collect();
        assert_eq!(kinds, ["removed", "added"]);
    }

    #[test]
    fn removed_block_is_reported_once() {
        let old = [block("A", "a"), block("B", "b")];
        let new = [block("A", "a")];
        let diffs = diff_blocks(&old, &new);
        let kinds: Vec<&str> = diffs.iter().map(|d| d.kind.as_str()).collect();
        assert_eq!(kinds, ["unchanged", "removed"]);
    }

    #[test]
    fn capitalising_a_question_is_an_edit_not_a_swap() {
        let old = [block("what is dns?", "a")];
        let new = [block("What is DNS?", "a")];
        let diffs = diff_blocks(&old, &new);
        // One block, still matched — and reported as an edit of the wording
        // rather than as a block that vanished and another that arrived.
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].kind, "changed");
        assert_eq!(diffs[0].question_old.as_deref(), Some("what is dns?"));
        assert_eq!(diffs[0].question, "What is DNS?");
        assert!(diffs[0].lines.is_empty(), "the answer did not change");
    }

    #[test]
    fn summary_counts_each_kind_of_block_change() {
        let old = [block("A", "a"), block("B", "b"), block("C", "c")];
        let new = [block("A", "a edited"), block("C", "c"), block("D", "d")];
        // D added, B removed, A edited — and C left alone.
        assert_eq!(count_changes(&diff_blocks(&old, &new)), (1, 1, 1));
    }
}
