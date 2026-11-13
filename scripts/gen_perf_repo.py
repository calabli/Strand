#!/usr/bin/env python3
"""造一个测性能用的仓库（说明书第 15 节），配合 `cargo run --release -p strand-core --example perf -- <仓库>`。

    mkdir /tmp/perf && cd /tmp/perf && git init -q -b main . \
      && python3 /path/to/scripts/gen_perf_repo.py 10000 5000 | git fast-import --quiet \
      && git checkout -q -f main && git config user.name 测试 && git config user.email t@example.com

参数：提交数（默认 10000）、文件数（默认 5000，按每个目录 100 个分开）。
- 第一个提交放下全部文件，外加 big/blame.txt（5000 行，用来测逐行追溯）和 big/diff.txt（3000 行）；
- 之后每个提交改一个文件；约 1/500 的提交改几行 big/blame.txt，让它有约 500 个版本的历史；
- 每 1000 个提交有一次旁支合并；每 500 个提交建一个 feature-N 分支；
- 最后一个提交改 big/diff.txt 的 2000 行（用来测差异）。
"""
import sys

commits = int(sys.argv[1]) if len(sys.argv) > 1 else 10_000
files = int(sys.argv[2]) if len(sys.argv) > 2 else 5_000
dirs = max(1, files // 100)
out = sys.stdout.buffer


def w(s):
    out.write(s.encode() if isinstance(s, str) else s)


def data(b):
    if isinstance(b, str):
        b = b.encode()
    w(f"data {len(b)}\n")
    w(b)
    w("\n")


t = 1_600_000_000
mark = 0


def commit(ref, msg, changes, parent=None, merge=None):
    global t, mark
    mark += 1
    t += 60
    w(f"commit {ref}\nmark :{mark}\ncommitter 林夏 <linxia@example.com> {t} +0800\n")
    data(msg)
    if parent:
        w(f"from {parent}\n")
    if merge:
        w(f"merge {merge}\n")
    for path, content in changes:
        w(f"M 100644 inline {path}\n")
        data(content)
    return mark


blame = [f"第 {i} 行：原始内容" for i in range(5000)]
diff = [f"diff 文件第 {i} 行" for i in range(3000)]
first = [(f"src/d{d:03d}/f{f:03d}.txt", f"文件 {d}/{f}\n") for d in range(dirs) for f in range(100)]
first += [("big/blame.txt", "\n".join(blame) + "\n"), ("big/diff.txt", "\n".join(diff) + "\n")]
main = commit("refs/heads/main", f"初始提交：{dirs * 100} 个文件", first)
blame_every = max(1, commits // 500)
for i in range(1, commits):
    d, f = (i * 7919) % dirs, (i * 104729) % 100
    ch = [(f"src/d{d:03d}/f{f:03d}.txt", f"文件 {d}/{f} 第 {i} 次修改\n")]
    if i % blame_every == 0:
        for k in range(10):
            j = (i * 37 + k * 499) % 5000
            blame[j] = f"第 {j} 行：在第 {i} 个提交改过"
        ch.append(("big/blame.txt", "\n".join(blame) + "\n"))
    if i % 1000 == 500:
        side = commit("refs/heads/side", f"旁支提交 {i}", [(f"side/s{i}.txt", "旁支\n")], parent=f":{mark}")
        main = commit("refs/heads/main", f"合并旁支 {i}", ch, parent=f":{main}", merge=f":{side}")
        continue
    main = commit("refs/heads/main", f"修改 src/d{d:03d}/f{f:03d}.txt（第 {i} 个提交）", ch, parent=f":{main}")
    if i % 500 == 0:
        w(f"reset refs/heads/feature-{i // 500}\nfrom :{main}\n\n")
for k in range(1000, 3000):
    diff[k] = f"diff 文件第 {k} 行：最后一个提交改过"
commit("refs/heads/main", "最后一个提交：改了 2000 行", [("big/diff.txt", "\n".join(diff) + "\n")], parent=f":{main}")
