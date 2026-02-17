# 🧠 claude-memory-bridge

> Share [Claude Code](https://claude.com/claude-code) session state across systems where the same projects live at different absolute paths.

**WSL2 ↔ dual-boot Linux** · **Docker ↔ host** · **NFS/SMB mounts** · **multiple machines, one disk**

---

## 🤔 The Problem

Claude Code stores session memory in `~/.claude/projects/<encoded-path>/` where the encoded path is your project's absolute path with `/` replaced by `-`.

If you access the **same project** from two systems with **different mount points**, Claude sees them as separate projects:

| System | Project Path | Claude Directory |
|--------|-------------|-----------------|
| WSL2 | `/home/user/projects/myapp` | `-home-user-projects-myapp` |
| Arch Linux | `/mnt/wsl2/home/user/projects/myapp` | `-mnt-wsl2-home-user-projects-myapp` |

💥 Two separate memory stores for the same project. Context, learnings, and session history don't carry over.

## ✅ The Solution

`claude-memory-bridge` creates symlinks so both systems share the same session state:

```
~/.claude/projects/-mnt-wsl2-home-user-projects-myapp
    → /mnt/wsl2/home/user/.claude/projects/-home-user-projects-myapp
```

Claude on Arch finds the WSL2 memory. Problem solved. 🎉

---

## 🚀 Quick Start

### Interactive Wizard (recommended)

Just run it — it auto-detects everything:

```bash
claude-memory-bridge
```

The wizard is **cwd-aware** — behavior depends on where you run it:

#### 📂 Inside a project directory

If a matching remote project is found, it offers to bridge just that one:

```
  ✓ Current directory matches remote project:
    -home-user-projects-myapp  --

  Bridge this project? [Y/n]
```

If **no automatic match** is found (different directory structures between systems), it lets you manually pick which remote project to bridge to:

```
  ! Current directory (-mnt-disk-work-myapp)
  No automatic match found in remote projects.

  Pick a remote project to bridge to this directory? [Y/n]

  Which remote project should this directory bridge to?

      1) -home-user-projects-myapp
      2) -home-user-projects-api-server
      3) -home-user-work-dashboard

  Select: 1
  ✓ 1 selected

  Bridge -mnt-disk-work-myapp
      → -home-user-projects-myapp? [Y/n]
```

#### 🌐 Outside a project directory (or from ~/)

Shows all remote projects and lets you pick which ones to bridge:

```
  Which projects do you want to bridge?

      1) -home-user-projects-myapp
      2) -home-user-projects-api-server
      3) -home-user-work-dashboard

  Enter numbers/ranges: 1,3,5-8  ·  a = all  ·  n = none

  Select: 1,3
  ✓ 2 selected
```

### Non-Interactive

```bash
claude-memory-bridge link \
  --source /mnt/wsl2/home/user/.claude/projects \
  --map '/home/user=/mnt/wsl2/home/user'
```

---

## 📦 Installation

### Option 1: Download Binary

Grab a prebuilt binary from [Releases](https://github.com/okroj-it/claude-memory-bridge/releases) and drop it in your PATH:

```bash
chmod +x claude-memory-bridge
sudo mv claude-memory-bridge /usr/local/bin/
```

### Option 2: Run with Bun

```bash
git clone https://github.com/okroj-it/claude-memory-bridge.git
cd claude-memory-bridge
bun run index.ts
```

### Option 3: Build from Source

See [Building](#-building) below.

---

## 🛠️ Commands

| Command | Description |
|---------|-------------|
| *(no args)* | 🧙 Interactive wizard — auto-detects everything |
| `status` | 📊 Show current bridges and their health |
| `scan` | 🔍 Preview what would be linked (dry run) |
| `link` | 🔗 Create symlinks |
| `unlink` | ✂️ Remove symlinks |
| `--help` | 📖 Show usage info |

### Options (for `scan`, `link`, `unlink`)

| Flag | Description |
|------|-------------|
| `--source <path>` | Path to remote `.claude/projects/` directory |
| `--map <remote>=<local>` | Path prefix mapping (remote system → local mount) |

---

## 💡 Examples

### WSL2 ↔ Arch Linux (dual boot)

WSL2 disk mounted at `/mnt/wsl2` on Arch:

```bash
# Interactive — just works
claude-memory-bridge

# Or explicitly
claude-memory-bridge link \
  --source /mnt/wsl2/home/user/.claude/projects \
  --map '/home/user=/mnt/wsl2/home/user'
```

### Docker ↔ Host

Project mounted into container at a different path:

```bash
claude-memory-bridge link \
  --source /host-home/.claude/projects \
  --map '/home/user=/host-home'
```

### NFS / SMB Share

Remote home directory mounted locally:

```bash
claude-memory-bridge link \
  --source /mnt/nas/home/user/.claude/projects \
  --map '/home/user=/mnt/nas/home/user'
```

### Check Status

```bash
claude-memory-bridge status
```

```
claude-memory-bridge — status

  → -mnt-wsl2-home-user-projects-myapp
    /mnt/wsl2/home/user/.claude/projects/-home-user-projects-myapp  ok
  ■ -home-user-projects-local-only

  1 bridged, 1 local
```

---

## 🏗️ Building

Requires [Bun](https://bun.sh) v1.0+.

### Build for Current Platform

```bash
bun build --compile index.ts --outfile claude-memory-bridge
```

### Cross-Compile All Targets

```bash
# 🐧 Linux x86-64
bun build --compile index.ts --outfile claude-memory-bridge-linux-x64

# 🐧 Linux aarch64 (Raspberry Pi, ARM servers)
bun build --compile --target=bun-linux-arm64 index.ts --outfile claude-memory-bridge-linux-arm64

# 🍎 macOS Apple Silicon (M1/M2/M3/M4)
bun build --compile --target=bun-darwin-arm64 index.ts --outfile claude-memory-bridge-macos-arm64

# 🍎 macOS Intel
bun build --compile --target=bun-darwin-x64 index.ts --outfile claude-memory-bridge-macos-x64
```

### Build All at Once

```bash
#!/bin/bash
targets=(
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-darwin-arm64:macos-arm64"
  "bun-darwin-x64:macos-x64"
)

for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  suffix="${entry##*:}"
  echo "Building claude-memory-bridge-${suffix}..."
  bun build --compile --target="${target}" index.ts --outfile "claude-memory-bridge-${suffix}"
done

echo "✅ Done!"
```

---

## 🔧 How It Works

1. **Scans** the remote `.claude/projects/` directory for project directories
2. **Matches** directories that start with the remote path prefix (encoded as hyphens)
3. **Computes** the local equivalent by swapping the remote prefix for the local prefix
4. **Creates symlinks** from the local encoded path to the remote source directory

```
Source (WSL2):  ~/.claude/projects/-home-user-projects-myapp/
                                    ^^^^^^^^^^
                                    remote prefix: /home/user

Local (Arch):   ~/.claude/projects/-mnt-wsl2-home-user-projects-myapp
                                    ^^^^^^^^^^^^^^^^^^^^^^
                                    local prefix: /mnt/wsl2/home/user
                ↓ symlink points to ↓
                /mnt/wsl2/home/user/.claude/projects/-home-user-projects-myapp/
```

---

## ⚠️ Notes

- **Run on the secondary system** — the one where the remote disk is mounted
- **Re-run after creating new projects** on the primary system to pick up new directories
- **Existing local directories are never overwritten** — only missing entries get symlinked
- **Stale symlinks are updated** — if a symlink points to the wrong target, it gets fixed
- Works with any number of path mappings and mount configurations

---

## 📄 License

MIT

---

<p align="center">
  Made for developers who refuse to lose context between reboots 🔄
</p>
