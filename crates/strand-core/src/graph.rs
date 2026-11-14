//! Graph lane layout.
//!
//! Input is the commits already sorted (newest first), each with the rows of its parents;
//! output is each row's lane and all segments drawn from that row to the next.
//!
//! Approach: keep a set of "active lanes", each recording the commit (row) it waits for next.
//! For each row, first find the lanes waiting for this commit (possibly several, merging into the leftmost),
//! then the first parent continues in this lane and other parents take a lane already waiting for them or open a new one.
//!
//! Long edges are collapsed (like JetBrains): an edge from child to parent spanning more than [`LONG`] rows is drawn for [`STUB`] rows and then capped with a down arrow
//! (`CutOut`), freeing the lane for other edges; [`STUB`] rows above the parent it takes a lane again and continues from an arrow (`CutIn`).
//! In repositories with many branches most lanes are such edges spanning thousands of rows; collapsing brings the width down to a dozen or so.

use crate::model::{Edge, EdgeKind, GraphRow};

/// Collapse edges spanning more than this many rows
pub const LONG: usize = 30;
/// A collapsed edge keeps this many rows at each end
pub const STUB: usize = 4;

pub struct Layout {
    pub rows: Vec<GraphRow>,
    pub lanes: u32,
}

/// An active lane: the row of the parent it waits for (`>= n` means not in the list; the line runs to the bottom), and the row where it collapses
#[derive(Clone, Copy, PartialEq)]
struct Slot {
    wait: usize,
    park_at: Option<usize>,
    /// The row this edge starts from (the child that last connected to it)
    from: usize,
}

/// `parents[i]` is the rows of the parents of the commit in row i; a parent not in the list uses a number `>= parents.len()`,
/// and the line runs to the bottom (collapsed the same way when too long, but never rejoined).
pub fn layout(parents: &[Vec<u32>]) -> Layout {
    let n = parents.len();
    let mut active: Vec<Option<Slot>> = Vec::new();
    let mut rows = Vec::with_capacity(n);
    let mut max_lanes = 0usize;
    // Collapsed edges: (row where it rejoins, parent's row, start row), sorted by rejoin row and taken from the end
    let mut parked: Vec<(usize, usize, usize)> = Vec::new();
    // Open a new lane waiting for p: when the span is too long, record the row where it collapses
    let slot = |row: usize, p: usize| Slot { wait: p, park_at: (p.min(n) - row > LONG).then_some(row + STUB), from: row };

    for (row, ps) in parents.iter().enumerate() {
        // 0. At a rejoin position: take a lane again (if a lane is already waiting for the same commit, join it)
        // If this row's commit also connects to this parent, the arrow is drawn on that lane after step 2 assigns lanes
        // The rejoining lane and the row this edge started from
        let mut cut_in: Vec<(usize, usize)> = Vec::new();
        let mut cut_in_later: Vec<(usize, usize)> = Vec::new();
        while let Some(&(at, p, from)) = parked.last() {
            if at > row {
                break;
            }
            parked.pop();
            if ps.iter().any(|&q| q as usize == p) && !active.iter().any(|w| w.is_some_and(|s| s.wait == p)) {
                cut_in_later.push((p, from));
                continue;
            }
            let l = match active.iter().position(|w| w.is_some_and(|s| s.wait == p)) {
                Some(l) => l,
                None => {
                    let l = free_lane(&mut active);
                    active[l] = Some(Slot { wait: p, park_at: None, from });
                    l
                }
            };
            cut_in.push((l, from));
        }

        // 1. Find every lane waiting for this commit
        let waiting: Vec<usize> = active.iter().enumerate().filter_map(|(i, w)| w.is_some_and(|s| s.wait == row).then_some(i)).collect();
        let lane = match waiting.first() {
            Some(&l) => l,
            None => free_lane(&mut active),
        };
        let before = active.clone();
        // The other lanes waiting for this commit merge here and are freed afterwards
        for &l in waiting.iter().skip(1) {
            active[l] = None;
        }

        // 2. Assign lanes to parents
        let ps: Vec<usize> = ps.iter().map(|&p| p as usize).collect();
        let mut merge_lanes = Vec::new();
        active[lane] = ps.first().map(|&p| slot(row, p));
        for &p in ps.iter().skip(1) {
            let l = match active.iter().position(|w| w.is_some_and(|s| s.wait == p)) {
                // Connected to an existing line: recompute where it collapses from this row, so it doesn't cap right after connecting
                Some(l) => {
                    active[l] = Some(slot(row, p));
                    l
                }
                None => {
                    let l = free_lane(&mut active);
                    active[l] = Some(slot(row, p));
                    l
                }
            };
            merge_lanes.push(l);
        }
        // If another lane already waits for the first parent, the two lines merge: keep the left one so the main line stays on the left
        let mut fork_to = None;
        let mut pulled_in = None;
        if let Some(&p) = ps.first()
            && let Some(other) = active.iter().enumerate().position(|(i, w)| i != lane && w.is_some_and(|s| s.wait == p))
        {
            if other < lane {
                active[lane] = None;
                active[other] = Some(slot(row, p));
                fork_to = Some(other);
            } else {
                // A line pulled over starts from this row when deciding whether to collapse
                active[other] = None;
                pulled_in = Some(other);
            }
        }

        // 3. Emit segments from this row to the next; lanes passing their collapse row are capped
        let mut edges = Vec::new();
        for (l, w) in before.iter().enumerate() {
            if l == lane || waiting.contains(&l) {
                continue;
            }
            let Some(w) = w else { continue };
            if pulled_in == Some(l) {
                edges.push(Edge { from_lane: l as u32, to_lane: lane as u32, kind: EdgeKind::Fork, target: None });
            } else if active[l].is_some_and(|s| s.wait == w.wait && s.park_at.is_some_and(|at| at <= row)) && !cut_in.iter().any(|c| c.0 == l) {
                let target = (w.wait < n).then_some(w.wait as u32);
                edges.push(Edge { from_lane: l as u32, to_lane: l as u32, kind: EdgeKind::CutOut, target });
                active[l] = None;
                // When a collapsed edge to the same parent is already waiting to rejoin, don't rejoin again
                if w.wait < n && !parked.iter().any(|&(_, p, _)| p == w.wait) {
                    let at = w.wait - STUB;
                    let i = parked.partition_point(|&(a, _, _)| a > at);
                    parked.insert(i, (at, w.wait, w.from));
                }
            } else if let Some(&(_, from)) = cut_in.iter().find(|c| c.0 == l) {
                edges.push(Edge { from_lane: l as u32, to_lane: l as u32, kind: EdgeKind::CutIn, target: Some(from as u32) });
            } else {
                edges.push(Edge { from_lane: l as u32, to_lane: l as u32, kind: EdgeKind::Straight, target: None });
            }
        }
        if !ps.is_empty() {
            let (to, kind) = match fork_to {
                Some(o) => (o, EdgeKind::Fork),
                None => (lane, EdgeKind::Straight),
            };
            edges.push(Edge { from_lane: lane as u32, to_lane: to as u32, kind, target: None });
        }
        for l in merge_lanes {
            edges.push(Edge { from_lane: lane as u32, to_lane: l as u32, kind: EdgeKind::Merge, target: None });
        }
        // The rejoining edge and this row connect to the same parent: draw the arrow on that lane
        for (p, from) in cut_in_later {
            if let Some(l) = active.iter().position(|w| w.is_some_and(|s| s.wait == p)) {
                edges.push(Edge { from_lane: l as u32, to_lane: l as u32, kind: EdgeKind::CutIn, target: Some(from as u32) });
            }
        }

        while matches!(active.last(), Some(None)) {
            active.pop();
        }
        max_lanes = max_lanes.max(active.len()).max(lane + 1);
        rows.push(GraphRow { lane: lane as u32, edges });
    }

    Layout { rows, lanes: max_lanes as u32 }
}

fn free_lane(active: &mut Vec<Option<Slot>>) -> usize {
    match active.iter().position(Option::is_none) {
        Some(i) => i,
        None => {
            active.push(None);
            active.len() - 1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lanes(l: &Layout) -> Vec<u32> {
        l.rows.iter().map(|r| r.lane).collect()
    }

    /// Write tests with names: `ids` newest first, `parents` given by name
    fn by_name(ids: &[char], parents: &[&[char]]) -> Layout {
        let pos = |c: &char| ids.iter().position(|x| x == c).unwrap() as u32;
        layout(&parents.iter().map(|ps| ps.iter().map(pos).collect()).collect::<Vec<_>>())
    }

    #[test]
    fn straight_line() {
        let l = by_name(&['c', 'b', 'a'], &[&['b'], &['a'], &[]]);
        assert_eq!(lanes(&l), vec![0, 0, 0]);
        assert_eq!(l.lanes, 1);
        assert!(l.rows[2].edges.is_empty());
    }

    #[test]
    fn branch_and_merge() {
        // 5 merges 4 and 3; 4 and 3 both branch from 2; 2 -> 1
        //   5
        //   |\
        //   4 |
        //   | 3
        //   |/
        //   2
        //   1
        let l = by_name(&['5', '4', '3', '2', '1'], &[&['4', '3'], &['2'], &['2'], &['1'], &[]]);
        assert_eq!(lanes(&l), vec![0, 0, 1, 0, 0]);
        assert_eq!(l.lanes, 2);
        assert!(l.rows[0].edges.contains(&Edge { from_lane: 0, to_lane: 1, kind: EdgeKind::Merge, target: None }));
        // Row 2: lane 0 passes by
        assert!(l.rows[2].edges.contains(&Edge { from_lane: 0, to_lane: 0, kind: EdgeKind::Straight, target: None }));
        // 3's parent 2 is already waited for in lane 0, so 3's line merges back into lane 0
        assert!(l.rows[2].edges.contains(&Edge { from_lane: 1, to_lane: 0, kind: EdgeKind::Fork, target: None }));
    }

    #[test]
    fn mainline_stays_left() {
        // m merges u (main line) and h (feature branch), both from r:
        // r should return to lane 0 rather than stay in the feature branch's lane 1
        let l = by_name(&['m', 'h', 'u', 'r'], &[&['u', 'h'], &['r'], &['r'], &[]]);
        assert_eq!(lanes(&l), vec![0, 1, 0, 0]);
        assert!(l.rows[2].edges.contains(&Edge { from_lane: 1, to_lane: 0, kind: EdgeKind::Fork, target: None }));
        assert!(l.rows[2].edges.contains(&Edge { from_lane: 0, to_lane: 0, kind: EdgeKind::Straight, target: None }));
    }

    #[test]
    fn two_unrelated_tips() {
        // Two branch heads b and a both point at r
        let l = by_name(&['b', 'a', 'r'], &[&['r'], &['r'], &[]]);
        assert_eq!(lanes(&l), vec![0, 1, 0]);
    }

    fn kinds_on(l: &Layout, lane: u32) -> Vec<(usize, EdgeKind)> {
        l.rows.iter().enumerate().flat_map(|(i, r)| r.edges.iter().filter(|e| e.from_lane == lane && e.to_lane == lane).map(move |e| (i, e.kind))).collect()
    }

    /// Main line 0..=99 is straight; row 0 also has a branch head t whose parent is row 80: spans 79 rows, collapsed
    #[test]
    fn long_edge_is_cut_and_comes_back() {
        let n = 100u32;
        // Row 0 is t, rows 1..100 are the main line (row i's parent is i+1)
        let mut parents: Vec<Vec<u32>> = vec![vec![80]];
        parents.extend((1..n).map(|i| if i + 1 < n { vec![i + 1] } else { vec![] }));
        let l = layout(&parents);
        // The main line starts in lane 0 at row 1 (t holds lane 0), t's line goes down lane 0...
        assert_eq!(l.rows[0].lane, 0);
        assert_eq!(l.rows[1].lane, 1);
        let t = kinds_on(&l, 0);
        // Rows 0..4 are straight and capped at row 4; it rejoins at row 76 and runs to row 79 (row 80 is the parent)
        assert_eq!(t.iter().find(|(_, k)| *k == EdgeKind::CutOut).map(|x| x.0), Some(4));
        assert_eq!(t.iter().find(|(_, k)| *k == EdgeKind::CutIn).map(|x| x.0), Some(76));
        assert!(t.iter().all(|&(i, _)| i <= 4 || i >= 76), "中间不画：{t:?}");
        // Clicking an arrow jumps to the other end: the cap points at the parent (row 80), the rejoin points at the child it started from (row 0)
        let target = |row: usize, k: EdgeKind| l.rows[row].edges.iter().find(|e| e.kind == k).and_then(|e| e.target);
        assert_eq!(target(4, EdgeKind::CutOut), Some(80));
        assert_eq!(target(76, EdgeKind::CutIn), Some(0));
        // The two lines merge at row 80 and the main line returns to the leftmost lane 0
        assert_eq!(l.rows[80].lane, 0);
        // The main line always uses a single lane: at most two
        assert_eq!(l.lanes, 2);
    }

    /// Many branches split off from one very early commit: after collapsing, only the main line remains in the middle
    #[test]
    fn many_long_branches_take_few_lanes() {
        // Rows 0..20 are 20 branch heads whose parent is row 500; rows 20..600 are the main line
        let n = 600u32;
        let mut parents: Vec<Vec<u32>> = (0..20).map(|_| vec![500]).collect();
        parents.extend((20..n).map(|i| if i + 1 < n { vec![i + 1] } else { vec![] }));
        let l = layout(&parents);
        // Only the main line passes around row 300
        assert!(l.rows[300].edges.len() <= 1, "{:?}", l.rows[300].edges);
        // A parent is rejoined only once
        let ins: usize = l.rows.iter().map(|r| r.edges.iter().filter(|e| e.kind == EdgeKind::CutIn).count()).sum();
        assert_eq!(ins, 1);
    }

    /// Long edges whose parent isn't in the list: not rejoined after collapsing
    #[test]
    fn edge_to_outside_is_cut_without_coming_back() {
        let n = 50u32;
        let mut parents: Vec<Vec<u32>> = vec![vec![1000]];
        parents.extend((1..n).map(|i| if i + 1 < n { vec![i + 1] } else { vec![] }));
        let l = layout(&parents);
        let t = kinds_on(&l, 0);
        assert_eq!(t.last().map(|x| x.1), Some(EdgeKind::CutOut));
        assert!(l.rows.iter().flat_map(|r| &r.edges).filter(|e| e.kind == EdgeKind::CutOut).all(|e| e.target.is_none()), "父提交不在列表里，没有可以跳的地方");
        assert!(l.rows.iter().all(|r| r.edges.iter().all(|e| e.kind != EdgeKind::CutIn)));
    }

    /// Randomly generate histories with branches and merges and check that lines are continuous:
    /// - lines passing a row (not the commit's lane) either come down from the previous row or are rejoin arrows;
    /// - lines coming down from the previous row either land on this row's commit or continue down (or are capped here);
    /// - a commit with children always has a line coming in on its row (unless all its children's lines collapsed and are still waiting at an arrow).
    #[test]
    fn random_histories_stay_connected() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut rnd = |m: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % m
        };
        for _ in 0..20 {
            let n = 1500usize;
            // Row i's parents are below it: usually the next row, sometimes far (old branches), sometimes a merge
            let parents: Vec<Vec<u32>> = (0..n)
                .map(|i| {
                    if i + 1 >= n {
                        return vec![];
                    }
                    let mut ps = vec![(i + 1 + if rnd(10) == 0 { rnd(400) as usize } else { 0 }).min(n - 1) as u32];
                    if rnd(8) == 0 {
                        let q = (i + 2 + rnd(200) as usize).min(n - 1) as u32;
                        if q != ps[0] {
                            ps.push(q);
                        }
                    }
                    ps
                })
                .collect();
            let l = layout(&parents);
            // On failure print a few rows around it for easier reading
            let around = |i: usize| (i.saturating_sub(6)..=i).map(|k| format!("{k}: 泳道 {} 父提交 {:?} 线段 {:?}", l.rows[k].lane, parents[k], l.rows[k].edges)).collect::<Vec<_>>().join("\n");
            for i in 1..n {
                let prev = &l.rows[i - 1];
                let cur = &l.rows[i];
                let incoming: Vec<u32> = prev.edges.iter().filter(|e| e.kind != EdgeKind::CutOut).map(|e| e.to_lane).collect();
                for e in cur.edges.iter().filter(|e| e.from_lane != cur.lane) {
                    assert!(e.kind == EdgeKind::CutIn || incoming.contains(&e.from_lane), "第 {i} 行泳道 {} 的线没有来处\n{}", e.from_lane, around(i));
                }
                for &to in &incoming {
                    assert!(to == cur.lane || cur.edges.iter().any(|e| e.from_lane == to), "第 {} 行连到泳道 {to} 的线在第 {i} 行断了\n{}", i - 1, around(i));
                }
            }
            // A cap's target is below, a rejoin's target is above
            for (i, r) in l.rows.iter().enumerate() {
                for e in &r.edges {
                    match e.kind {
                        EdgeKind::CutOut => assert!(e.target.is_none_or(|t| t as usize > i)),
                        EdgeKind::CutIn => assert!(e.target.is_some_and(|t| (t as usize) < i)),
                        _ => assert!(e.target.is_none()),
                    }
                }
            }
            assert!(l.lanes < 40, "泳道 {} 条", l.lanes);
        }
    }
}
