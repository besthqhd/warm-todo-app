#!/usr/bin/env python3
"""
暖心Todo -> GitHub 同步脚本（仅用 api.github.com，绕开被屏蔽的 github.com:443）
用法:
  GHTOKEN=ghp_xxx python sync_github.py
说明:
  - 只上传变动的文件，避免冗余 commit
  - token 从环境变量读取，不写死在文件里
"""
import os, base64, json, urllib.request, urllib.parse

TOKEN = os.environ.get("GHTOKEN")
if not TOKEN:
    raise SystemExit("ERROR: 请先设置环境变量 GHTOKEN=ghp_xxx")

OWNER = "besthqhd"
REPO = "warm-todo-app"
BASE = f"https://api.github.com/repos/{OWNER}/{REPO}/contents"

# 需要同步的文件: (本地路径, 仓库内路径)
FILES = [
    ("index.html", "index.html"),
    (".gitignore", ".gitignore"),
    ("PRD_暖心Todo.md", "PRD_暖心Todo.md"),
]

def api_get(path):
    req = urllib.request.Request(f"{BASE}/{urllib.parse.quote(path)}", headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "warm-todo-sync"
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise

def api_put(repo_path, content_b64, sha, message):
    body = {"message": message, "content": content_b64, "branch": "main"}
    if sha:
        body["sha"] = sha
    req = urllib.request.Request(
        f"{BASE}/{urllib.parse.quote(repo_path)}", data=json.dumps(body).encode("utf-8"),
        method="PUT", headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "warm-todo-sync"
        })
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))

for local, repo in FILES:
    if not os.path.exists(local):
        print(f"SKIP {repo} (本地不存在)")
        continue
    with open(local, "rb") as f:
        data = f.read()
    b64 = base64.b64encode(data).decode("ascii")
    existing = api_get(repo)
    if existing and existing.get("sha"):
        import hashlib
        # 比较内容是否真的变了
        remote_b64 = existing.get("content", "").replace("\n", "")
        if remote_b64 == b64:
            print(f"UNCHANGED {repo}")
            continue
        sha = existing["sha"]
        msg = f"update: {repo}"
    else:
        sha = None
        msg = f"add: {repo}"
    res = api_put(repo, b64, sha, msg)
    print(f"PUSHED {repo} -> {res.get('commit',{}).get('sha','?')[:10]}")

print("SYNC DONE")
