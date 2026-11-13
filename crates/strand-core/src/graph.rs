//! 图谱泳道布局。
//!
//! 输入是已经排好序的提交（新的在前），每个提交给出父提交所在的行号；
//! 输出每一行所在的泳道，以及从这一行画到下一行的所有线段。
//!
//! 做法：维护一组“活动泳道”，每条泳道记着它下一步等待的提交（行号）。
//! 处理一行时，先找等待这个提交的泳道（可能有多条，汇合到最左边那条），
//! 然后第一个父提交沿用本泳道，其余父提交找已在等待它的泳道或开新泳道。
//!
//! 长连线折叠（和 JetBrains 一样）：子提交到父提交跨过超过 [`LONG`] 行的线，画 [`STUB`] 行后用向下的箭头收住
//! （`CutOut`），泳道空出来给别的线用；到父提交上方 [`STUB`] 行时重新占一条泳道，从箭头接回来（`CutIn`）。
//! 分支多的仓库里，大部分泳道都是这种跨过几千行的长线，折叠后宽度降到十几条。

use crate::model::{Edge, EdgeKind, GraphRow};

/// 跨过超过这么多行的连线折叠
pub const LONG: usize = 30;
/// 折叠的线在两头各留这么多行
pub const STUB: usize = 4;

pub struct Layout {
    pub rows: Vec<GraphRow>,
    pub lanes: u32,
}

/// 一条活动泳道：等待的父提交所在的行（`>= n` 表示不在列表里，线一直画到底），以及在哪一行折叠
#[derive(Clone, Copy, PartialEq)]
struct Slot {
    wait: usize,
    park_at: Option<usize>,
    /// 这条线从哪一行出发（最近连上它的子提交）
    from: usize,
}

/// `parents[i]` 是第 i 行提交的父提交所在的行号；父提交不在列表里时用 `>= parents.len()` 的数，
/// 线会一直画到底部（太长时同样折叠，只是不再接回来）。
pub fn layout(parents: &[Vec<u32>]) -> Layout {
    let n = parents.len();
    let mut active: Vec<Option<Slot>> = Vec::new();
    let mut rows = Vec::with_capacity(n);
    let mut max_lanes = 0usize;
    // 折叠了的线：(在哪一行接回来, 父提交所在的行, 出发的行)，按接回的行排序后从末尾取
    let mut parked: Vec<(usize, usize, usize)> = Vec::new();
    // 新开一条等 p 的泳道：跨度太长时记下在哪一行折叠
    let slot = |row: usize, p: usize| Slot { wait: p, park_at: (p.min(n) - row > LONG).then_some(row + STUB), from: row };

    for (row, ps) in parents.iter().enumerate() {
        // 0. 到了接回来的位置：重新占一条泳道（已经有泳道在等同一个提交时就接在它上面）
        // 本行提交自己也连到这个父提交时，等第 2 步分好泳道后，箭头画在连过去的那条泳道上
        // 接回来的泳道和这条线出发的行
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

        // 1. 找出所有在等这个提交的泳道
        let waiting: Vec<usize> = active.iter().enumerate().filter_map(|(i, w)| w.is_some_and(|s| s.wait == row).then_some(i)).collect();
        let lane = match waiting.first() {
            Some(&l) => l,
            None => free_lane(&mut active),
        };
        let before = active.clone();
        // 其余等这个提交的泳道在这里汇合，之后空出来
        for &l in waiting.iter().skip(1) {
            active[l] = None;
        }

        // 2. 父提交分配泳道
        let ps: Vec<usize> = ps.iter().map(|&p| p as usize).collect();
        let mut merge_lanes = Vec::new();
        active[lane] = ps.first().map(|&p| slot(row, p));
        for &p in ps.iter().skip(1) {
            let l = match active.iter().position(|w| w.is_some_and(|s| s.wait == p)) {
                // 连到已有的线上：从本行起重新算在哪里折叠，免得刚连上就收住
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
        // 第一个父提交如果已经有别的泳道在等：两条线要汇合，保留靠左的那条，让主线始终在左边
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
                // 拉过来的线以本行为起点重新算要不要折叠
                active[other] = None;
                pulled_in = Some(other);
            }
        }

        // 3. 生成从本行到下一行的线段；经过的泳道到了折叠的那一行就收住
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
                // 同一个父提交已经有折叠的线等着接回来时，不用再接一次
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
        // 接回来的线和本行连向同一个父提交：箭头画在那条泳道上
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

    /// 用名字写测试：`ids` 新的在前，`parents` 按名字给出
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
        // 5 合并了 4 和 3；4、3 都从 2 分出来；2 -> 1
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
        // 第 2 行：泳道 0 从旁边经过
        assert!(l.rows[2].edges.contains(&Edge { from_lane: 0, to_lane: 0, kind: EdgeKind::Straight, target: None }));
        // 3 的父提交 2 已经在泳道 0 等着，所以 3 这条线汇回泳道 0
        assert!(l.rows[2].edges.contains(&Edge { from_lane: 1, to_lane: 0, kind: EdgeKind::Fork, target: None }));
    }

    #[test]
    fn mainline_stays_left() {
        // m 合并了 u（主线）和 h（功能分支），两者都来自 r：
        // r 应当回到泳道 0，而不是留在功能分支的泳道 1
        let l = by_name(&['m', 'h', 'u', 'r'], &[&['u', 'h'], &['r'], &['r'], &[]]);
        assert_eq!(lanes(&l), vec![0, 1, 0, 0]);
        assert!(l.rows[2].edges.contains(&Edge { from_lane: 1, to_lane: 0, kind: EdgeKind::Fork, target: None }));
        assert!(l.rows[2].edges.contains(&Edge { from_lane: 0, to_lane: 0, kind: EdgeKind::Straight, target: None }));
    }

    #[test]
    fn two_unrelated_tips() {
        // 两个分支头 b、a 都指向 r
        let l = by_name(&['b', 'a', 'r'], &[&['r'], &['r'], &[]]);
        assert_eq!(lanes(&l), vec![0, 1, 0]);
    }

    fn kinds_on(l: &Layout, lane: u32) -> Vec<(usize, EdgeKind)> {
        l.rows.iter().enumerate().flat_map(|(i, r)| r.edges.iter().filter(|e| e.from_lane == lane && e.to_lane == lane).map(move |e| (i, e.kind))).collect()
    }

    /// 主线 0..=99 一条直线；第 0 行另有一个分支头 t，父提交是第 80 行：跨 79 行，折叠
    #[test]
    fn long_edge_is_cut_and_comes_back() {
        let n = 100u32;
        // 第 0 行是 t，第 1..100 行是主线（第 i 行的父提交是 i+1）
        let mut parents: Vec<Vec<u32>> = vec![vec![80]];
        parents.extend((1..n).map(|i| if i + 1 < n { vec![i + 1] } else { vec![] }));
        let l = layout(&parents);
        // 主线从第 1 行开始在泳道 0（t 占了泳道 0），t 的线在泳道 0 往下……
        assert_eq!(l.rows[0].lane, 0);
        assert_eq!(l.rows[1].lane, 1);
        let t = kinds_on(&l, 0);
        // 第 0..4 行是直线，第 4 行收住；第 76 行接回来，一直画到第 79 行（第 80 行是父提交）
        assert_eq!(t.iter().find(|(_, k)| *k == EdgeKind::CutOut).map(|x| x.0), Some(4));
        assert_eq!(t.iter().find(|(_, k)| *k == EdgeKind::CutIn).map(|x| x.0), Some(76));
        assert!(t.iter().all(|&(i, _)| i <= 4 || i >= 76), "中间不画：{t:?}");
        // 点箭头跳到另一头：收住处指向父提交（第 80 行），接回处指向出发的子提交（第 0 行）
        let target = |row: usize, k: EdgeKind| l.rows[row].edges.iter().find(|e| e.kind == k).and_then(|e| e.target);
        assert_eq!(target(4, EdgeKind::CutOut), Some(80));
        assert_eq!(target(76, EdgeKind::CutIn), Some(0));
        // 第 80 行两条线汇合，主线回到最左边的泳道 0
        assert_eq!(l.rows[80].lane, 0);
        // 主线始终只用一条泳道：最多两条
        assert_eq!(l.lanes, 2);
    }

    /// 很多条分支都从很早的一个提交分出来：折叠后中间那段只剩主线
    #[test]
    fn many_long_branches_take_few_lanes() {
        // 第 0..20 行是 20 个分支头，父提交都是第 500 行；第 20..600 行是主线
        let n = 600u32;
        let mut parents: Vec<Vec<u32>> = (0..20).map(|_| vec![500]).collect();
        parents.extend((20..n).map(|i| if i + 1 < n { vec![i + 1] } else { vec![] }));
        let l = layout(&parents);
        // 第 300 行附近只有主线经过
        assert!(l.rows[300].edges.len() <= 1, "{:?}", l.rows[300].edges);
        // 接回来时同一个父提交只接一次
        let ins: usize = l.rows.iter().map(|r| r.edges.iter().filter(|e| e.kind == EdgeKind::CutIn).count()).sum();
        assert_eq!(ins, 1);
    }

    /// 父提交不在列表里的长线：折叠后不再接回来
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

    /// 随机生成带分支和合并的历史，检查线是连续的：
    /// - 本行经过的线（不是本行提交的泳道）要么是上一行连下来的，要么是接回来的箭头；
    /// - 上一行连下来的线要么落在本行的提交上，要么在本行继续往下（或在本行收住）；
    /// - 有子提交的提交，本行一定有线连进来（除非它的子提交的线都折叠了、还在箭头那里接回）。
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
            // 第 i 行的父提交在它下面：多数是下一行，有时跳很远（老分支），有时是合并
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
            // 出错时打印出事前后几行，方便看
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
            // 收住处的目标在下面、接回处的目标在上面
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
