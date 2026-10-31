#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 src/core.js 与 src/probe.js 注入到两个模板里，生成可直接分发的单文件脚本。

产物:
    dist/autofts.sh    Linux / Termux / macOS 用，LF 换行，带执行位
    dist/autofts.ps1   Windows 用，CRLF 换行 + UTF-8 BOM

为什么 ps1 必须是 CRLF + BOM:
    * 没有 BOM，PowerShell 5.1 会按系统代码页(中文机器是 GBK)解析，中文全部乱码；
    * 只有 LF，Windows 控制台里的 here-string 不会回车，帮助文本会串成一行。

用法:
    python3 build/build.py
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "src")
TPL_DIR = os.path.join(ROOT, "templates")
DIST_DIR = os.path.join(ROOT, "dist")

CORE_MARK = "@@CORE_JS@@"
PROBE_MARK = "@@PROBE_JS@@"


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


def check_ps_safe(name, body):
    """PowerShell here-string 遇到行首的 '@ 会提前结束，必须确保源码里没有。"""
    for lineno, line in enumerate(body.split("\n"), 1):
        if line.startswith("'@") or line.startswith('"@'):
            sys.exit(
                "错误: %s 第 %d 行以 %r 开头，会提前终止 PowerShell here-string"
                % (name, lineno, line[:2])
            )


def main():
    core = read_text(os.path.join(SRC_DIR, "core.js"))
    probe = read_text(os.path.join(SRC_DIR, "probe.js"))
    check_ps_safe("src/core.js", core)
    check_ps_safe("src/probe.js", probe)
    # 模板里占位符独占一行，源码结尾的换行要先去掉，否则会多出一个空行
    core_inject = core.rstrip("\n")
    probe_inject = probe.rstrip("\n")

    os.makedirs(DIST_DIR, exist_ok=True)

    # ---- Linux / Termux ----
    sh = read_text(os.path.join(TPL_DIR, "autofts.sh.tpl"))
    if CORE_MARK not in sh or PROBE_MARK not in sh:
        sys.exit("错误: autofts.sh.tpl 里缺少占位符")
    sh = sh.replace(CORE_MARK, core_inject).replace(PROBE_MARK, probe_inject)
    sh_path = os.path.join(DIST_DIR, "autofts.sh")
    with open(sh_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(sh)
    try:
        os.chmod(sh_path, 0o755)
    except OSError:
        pass  # Windows 上无所谓，Linux 上才有意义

    # ---- Windows ----
    ps = read_text(os.path.join(TPL_DIR, "autofts.ps1.tpl"))
    if CORE_MARK not in ps or PROBE_MARK not in ps:
        sys.exit("错误: autofts.ps1.tpl 里缺少占位符")
    ps = ps.replace(CORE_MARK, core_inject).replace(PROBE_MARK, probe_inject)
    ps = ps.replace("\r\n", "\n").replace("\n", "\r\n")
    ps_path = os.path.join(DIST_DIR, "autofts.ps1")
    # utf-8-sig = 写 BOM；newline="" 防止 Python 再动一次换行
    with open(ps_path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(ps)

    for p in (sh_path, ps_path):
        size = os.path.getsize(p)
        print("已生成 %-24s %8.1f KB" % (os.path.relpath(p, ROOT), size / 1024.0))


if __name__ == "__main__":
    main()
