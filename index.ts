#!/usr/bin/env bun
/**
 * claude-memory-bridge
 *
 * Share Claude Code session state across systems where the same projects
 * are accessed via different absolute paths (e.g., WSL2 + dual-boot Linux,
 * multiple mount points, Docker, NFS, etc.)
 *
 * Run without arguments for interactive wizard, or use commands directly.
 */

import { existsSync, readdirSync, lstatSync, symlinkSync, unlinkSync, mkdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

// --- Terminal colors ---

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

// --- Readline ---

let _rl: ReturnType<typeof createInterface> | null = null;

function getRL() {
  if (!_rl) {
    _rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  return _rl;
}

function closeRL() {
  _rl?.close();
  _rl = null;
}

async function ask(question: string): Promise<string> {
  return (await getRL().question(question)).trim();
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${DIM}${hint}${RESET} `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

async function choose(question: string, options: string[]): Promise<number> {
  console.log(`\n  ${BOLD}${question}${RESET}\n`);
  for (let i = 0; i < options.length; i++) {
    console.log(`    ${CYAN}${i + 1}${RESET}) ${options[i]}`);
  }
  console.log();

  while (true) {
    const answer = await ask(`  Choice ${DIM}[1-${options.length}]${RESET}: `);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= options.length) return num - 1;
    console.log(`  ${RED}Invalid choice. Enter 1-${options.length}.${RESET}`);
  }
}

// --- Path encoding ---

function encodePrefix(prefix: string): string {
  return prefix.replaceAll("/", "-");
}

// --- Auto-detection ---

interface DetectedSource {
  /** Full path to the remote .claude/projects/ directory */
  projectsPath: string;
  /** The parent of .claude/ (the "home" on the local filesystem) */
  localHome: string;
  /** Number of project directories found */
  projectCount: number;
}

function scanForRemoteClaude(): DetectedSource[] {
  const results: DetectedSource[] = [];
  const localProjectsPath = join(homedir(), ".claude", "projects");

  const searchRoots = ["/mnt", "/media", "/run/media", "/Volumes"];

  for (const root of searchRoots) {
    if (!existsSync(root)) continue;

    try {
      // depth 1: /mnt/wsl2, /mnt/usb, etc.
      for (const d1 of safeReaddir(root)) {
        const p1 = join(root, d1);
        if (!isDir(p1)) continue;
        checkForClaudeUnder(p1, localProjectsPath, results);

        // depth 2: /mnt/wsl2/home/user, /run/media/user/disk, etc.
        for (const d2 of safeReaddir(p1)) {
          const p2 = join(p1, d2);
          if (!isDir(p2)) continue;
          checkForClaudeUnder(p2, localProjectsPath, results);

          // depth 3: handles /mnt/disk/home/user
          for (const d3 of safeReaddir(p2)) {
            const p3 = join(p2, d3);
            if (!isDir(p3)) continue;
            checkForClaudeUnder(p3, localProjectsPath, results);
          }
        }
      }
    } catch {
      // permission errors, etc. — skip silently
    }
  }

  return results;
}

function checkForClaudeUnder(basePath: string, excludePath: string, results: DetectedSource[]): void {
  const claudeProjects = join(basePath, ".claude", "projects");
  if (!existsSync(claudeProjects)) return;

  // Don't detect our own .claude/projects/
  if (resolve(claudeProjects) === resolve(excludePath)) return;

  try {
    const entries = readdirSync(claudeProjects).filter((e) => e.startsWith("-"));
    if (entries.length === 0) return;

    results.push({
      projectsPath: claudeProjects,
      localHome: resolve(basePath),
      projectCount: entries.length,
    });
  } catch {
    // can't read — skip
  }
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect the remote path prefix by finding the common prefix of all
 * directory names in the remote projects directory.
 *
 * e.g., if all dirs start with "-home-lambert", the remote prefix
 * was "/home/lambert" on the source system.
 */
function detectRemotePrefix(projectsPath: string): string | null {
  const entries = readdirSync(projectsPath).filter((e) => e.startsWith("-"));
  if (entries.length === 0) return null;

  // Find longest common prefix
  let prefix = entries[0];
  for (const entry of entries.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < entry.length && prefix[i] === entry[i]) {
      i++;
    }
    prefix = prefix.slice(0, i);
  }

  // Trim to last hyphen boundary (avoid partial segments)
  const lastHyphen = prefix.lastIndexOf("-");
  if (lastHyphen > 0) {
    prefix = prefix.slice(0, lastHyphen);
  }

  // Must be at least something meaningful (e.g., "-home-user")
  if (prefix.length < 3) return null;

  return prefix;
}

// --- Core logic ---

interface ProjectMapping {
  sourceDirName: string;
  sourceFullPath: string;
  localDirName: string;
  localFullPath: string;
  localState: "missing" | "symlink-correct" | "symlink-wrong" | "directory-exists";
}

function discoverMappings(
  sourcePath: string,
  remotePrefix: string,
  localPrefix: string,
): ProjectMapping[] {
  const localClaudeProjects = join(homedir(), ".claude", "projects");
  const encodedRemote = encodePrefix(remotePrefix);
  const encodedLocal = encodePrefix(localPrefix);

  if (!existsSync(sourcePath)) {
    console.error(`Source path does not exist: ${sourcePath}`);
    process.exit(1);
  }

  const entries = readdirSync(sourcePath, { withFileTypes: true });
  const mappings: ProjectMapping[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const dirName = entry.name;
    if (!dirName.startsWith(encodedRemote)) continue;

    const suffix = dirName.slice(encodedRemote.length);
    const localDirName = encodedLocal + suffix;

    const sourceFullPath = join(sourcePath, dirName);
    const localFullPath = join(localClaudeProjects, localDirName);

    let localState: ProjectMapping["localState"] = "missing";
    if (existsSync(localFullPath)) {
      try {
        const stat = lstatSync(localFullPath);
        if (stat.isSymbolicLink()) {
          const target = readlinkSync(localFullPath);
          localState = resolve(target) === resolve(sourceFullPath) ? "symlink-correct" : "symlink-wrong";
        } else {
          localState = "directory-exists";
        }
      } catch {
        localState = "missing";
      }
    }

    mappings.push({ sourceDirName: dirName, sourceFullPath, localDirName, localFullPath, localState });
  }

  return mappings;
}

function stateIcon(state: ProjectMapping["localState"]): string {
  switch (state) {
    case "symlink-correct":  return `${GREEN}linked${RESET}`;
    case "symlink-wrong":    return `${YELLOW}stale${RESET}`;
    case "directory-exists": return `${YELLOW}local dir${RESET}`;
    case "missing":          return `${DIM}--${RESET}`;
  }
}

function doLink(mappings: ProjectMapping[]): { created: number; updated: number; skipped: number } {
  const localClaudeProjects = join(homedir(), ".claude", "projects");
  if (!existsSync(localClaudeProjects)) {
    mkdirSync(localClaudeProjects, { recursive: true });
  }

  let created = 0, updated = 0, skipped = 0;

  for (const m of mappings) {
    switch (m.localState) {
      case "symlink-correct":
        skipped++;
        break;
      case "symlink-wrong":
        unlinkSync(m.localFullPath);
        symlinkSync(m.sourceFullPath, m.localFullPath);
        updated++;
        break;
      case "directory-exists":
        skipped++;
        break;
      case "missing":
        symlinkSync(m.sourceFullPath, m.localFullPath);
        created++;
        break;
    }
  }

  return { created, updated, skipped };
}

// --- Interactive Wizard ---

async function cmdWizard(): Promise<void> {
  console.log(`\n  ${BOLD}${MAGENTA}claude-memory-bridge${RESET}${BOLD} — interactive setup${RESET}\n`);

  // Step 1: Show local state
  const localClaudeProjects = join(homedir(), ".claude", "projects");
  if (existsSync(localClaudeProjects)) {
    const localCount = readdirSync(localClaudeProjects).length;
    console.log(`  ${GREEN}✓${RESET} Local Claude projects: ${localClaudeProjects} ${DIM}(${localCount} projects)${RESET}`);
  } else {
    console.log(`  ${DIM}No local .claude/projects/ yet (will be created)${RESET}`);
  }

  // Step 2: Scan for remote Claude installations
  console.log(`\n  Scanning mounted filesystems for remote Claude installations...`);
  const detected = scanForRemoteClaude();

  let sourcePath: string;
  let remotePrefix: string;
  let localPrefix: string;

  if (detected.length > 0) {
    console.log(`  ${GREEN}✓${RESET} Found ${detected.length} remote installation(s):\n`);

    for (let i = 0; i < detected.length; i++) {
      const d = detected[i];
      const encodedPrefix = detectRemotePrefix(d.projectsPath);
      console.log(`    ${CYAN}${i + 1}${RESET}) ${d.projectsPath}`);
      console.log(`       ${DIM}${d.projectCount} projects, home: ${d.localHome}${RESET}`);
      if (encodedPrefix) {
        console.log(`       ${DIM}remote prefix: ${encodedPrefix}${RESET}`);
      }
    }

    let selectedSource: DetectedSource;

    if (detected.length === 1) {
      console.log();
      const useIt = await confirm(`  Use ${BOLD}${detected[0].projectsPath}${RESET}?`);
      if (!useIt) {
        const custom = await ask(`  Enter path to remote .claude/projects/: `);
        selectedSource = {
          projectsPath: custom,
          localHome: resolve(custom, "..", ".."),
          projectCount: existsSync(custom) ? readdirSync(custom).length : 0,
        };
      } else {
        selectedSource = detected[0];
      }
    } else {
      const options = detected.map(
        (d) => `${d.projectsPath} ${DIM}(${d.projectCount} projects)${RESET}`,
      );
      options.push("Enter a custom path");
      const choice = await choose("Which remote installation?", options);

      if (choice === detected.length) {
        const custom = await ask(`  Enter path to remote .claude/projects/: `);
        selectedSource = {
          projectsPath: custom,
          localHome: resolve(custom, "..", ".."),
          projectCount: existsSync(custom) ? readdirSync(custom).length : 0,
        };
      } else {
        selectedSource = detected[choice];
      }
    }

    sourcePath = selectedSource.projectsPath;
    localPrefix = selectedSource.localHome;

    // Step 3: Auto-detect remote prefix
    const autoPrefix = detectRemotePrefix(sourcePath);
    if (autoPrefix) {
      // Decode for display (best-effort, may be wrong with hyphens in names)
      console.log(`\n  ${GREEN}✓${RESET} Detected path mapping:`);
      console.log(`    Remote encoded prefix: ${BOLD}${autoPrefix}${RESET}`);
      console.log(`    Local mount path:      ${BOLD}${localPrefix}${RESET}`);
      console.log(`    Local encoded prefix:  ${BOLD}${encodePrefix(localPrefix)}${RESET}`);

      const useMapping = await confirm(`\n  Use this mapping?`);
      if (useMapping) {
        // We need to convert the encoded remote prefix back to a path for discoverMappings
        // Since discoverMappings uses encodePrefix(), we need the raw path
        // The encoded prefix IS what we match against, so we pass a "fake" path
        // that encodes to the detected prefix. We use the prefix directly.
        remotePrefix = autoPrefix.replaceAll("-", "/");
      } else {
        remotePrefix = await ask(`  Enter remote path prefix (e.g. /home/user): `);
      }
    } else {
      console.log(`\n  ${YELLOW}!${RESET} Could not auto-detect remote prefix.`);
      remotePrefix = await ask(`  Enter remote path prefix (e.g. /home/user): `);
    }
  } else {
    console.log(`  ${YELLOW}!${RESET} No remote installations found automatically.\n`);

    sourcePath = await ask(`  Enter path to remote .claude/projects/: `);
    if (!existsSync(sourcePath)) {
      console.log(`  ${RED}Path does not exist: ${sourcePath}${RESET}`);
      closeRL();
      process.exit(1);
    }

    localPrefix = resolve(sourcePath, "..", "..");
    console.log(`  ${DIM}Inferred local mount: ${localPrefix}${RESET}`);

    const autoPrefix = detectRemotePrefix(sourcePath);
    if (autoPrefix) {
      console.log(`  ${GREEN}✓${RESET} Detected remote prefix: ${BOLD}${autoPrefix}${RESET}`);
      const useIt = await confirm(`  Use this?`);
      remotePrefix = useIt ? autoPrefix.replaceAll("-", "/") : await ask(`  Enter remote path prefix: `);
    } else {
      remotePrefix = await ask(`  Enter remote path prefix (e.g. /home/user): `);
    }
  }

  // Step 4: Discover and preview
  console.log(`\n  Discovering projects...\n`);
  const mappings = discoverMappings(sourcePath, remotePrefix, localPrefix);

  const linkable = mappings.filter((m) => m.localState === "missing" || m.localState === "symlink-wrong");
  const linked = mappings.filter((m) => m.localState === "symlink-correct");
  const conflicts = mappings.filter((m) => m.localState === "directory-exists");

  // Compact table view
  console.log(`  ${BOLD}${mappings.length} project(s) found:${RESET}\n`);
  const maxNameLen = Math.min(
    50,
    Math.max(...mappings.map((m) => m.sourceDirName.length)),
  );

  for (const m of mappings) {
    const name = m.sourceDirName.length > 50
      ? "..." + m.sourceDirName.slice(-47)
      : m.sourceDirName.padEnd(maxNameLen);
    console.log(`    ${name}  ${stateIcon(m.localState)}`);
  }

  console.log(`\n  ${GREEN}${linked.length}${RESET} already linked, ${CYAN}${linkable.length}${RESET} to link, ${YELLOW}${conflicts.length}${RESET} conflicts\n`);

  if (linkable.length === 0) {
    console.log(`  Nothing to do — all projects are already bridged!\n`);
    closeRL();
    return;
  }

  // Step 5: Confirm and link
  const proceed = await confirm(`  Create ${BOLD}${linkable.length}${RESET} symlink(s)?`);
  if (!proceed) {
    console.log(`\n  Cancelled.\n`);
    closeRL();
    return;
  }

  const { created, updated, skipped } = doLink(mappings);
  console.log(`\n  ${GREEN}✓${RESET} ${BOLD}Done:${RESET} ${created} created, ${updated} updated, ${skipped} skipped`);

  // Step 6: Show the command for next time
  console.log(`\n  ${DIM}Next time, run non-interactively:${RESET}`);
  console.log(`  ${DIM}claude-memory-bridge link --source '${sourcePath}' --map '${remotePrefix}=${localPrefix}'${RESET}\n`);

  closeRL();
}

// --- Non-interactive commands ---

function cmdScan(sourcePath: string, remotePrefix: string, localPrefix: string): void {
  console.log(`\n${BOLD}claude-memory-bridge${RESET} — scan\n`);
  console.log(`  Source:  ${sourcePath}`);
  console.log(`  Map:    ${remotePrefix} → ${localPrefix}`);

  const mappings = discoverMappings(sourcePath, remotePrefix, localPrefix);
  const linkable = mappings.filter((m) => m.localState === "missing" || m.localState === "symlink-wrong");
  const linked = mappings.filter((m) => m.localState === "symlink-correct");

  console.log(`\n  ${BOLD}${mappings.length}${RESET} project(s):\n`);
  for (const m of mappings) {
    console.log(`  ${m.sourceDirName}  ${stateIcon(m.localState)}`);
  }

  console.log(`\n  ${GREEN}${linked.length}${RESET} linked, ${CYAN}${linkable.length}${RESET} can be linked`);
  if (linkable.length > 0) {
    console.log(`  Run ${BOLD}link${RESET} to create symlinks.`);
  }
  console.log();
}

function cmdLink(sourcePath: string, remotePrefix: string, localPrefix: string): void {
  console.log(`\n${BOLD}claude-memory-bridge${RESET} — link\n`);

  const mappings = discoverMappings(sourcePath, remotePrefix, localPrefix);
  const { created, updated, skipped } = doLink(mappings);

  for (const m of mappings) {
    const label = m.sourceDirName.split("-").pop() || m.sourceDirName;
    switch (m.localState) {
      case "missing":
        console.log(`  ${GREEN}link${RESET}    ${label}`);
        break;
      case "symlink-wrong":
        console.log(`  ${YELLOW}update${RESET}  ${label}`);
        break;
      case "symlink-correct":
        console.log(`  ${DIM}skip${RESET}    ${label}`);
        break;
      case "directory-exists":
        console.log(`  ${RED}skip${RESET}    ${label} (local dir exists)`);
        break;
    }
  }

  console.log(`\n  ${BOLD}Done:${RESET} ${created} created, ${updated} updated, ${skipped} skipped\n`);
}

function cmdUnlink(sourcePath: string, remotePrefix: string, localPrefix: string): void {
  console.log(`\n${BOLD}claude-memory-bridge${RESET} — unlink\n`);

  const mappings = discoverMappings(sourcePath, remotePrefix, localPrefix);
  let removed = 0;

  for (const m of mappings) {
    if (m.localState === "symlink-correct" || m.localState === "symlink-wrong") {
      unlinkSync(m.localFullPath);
      const label = m.sourceDirName.split("-").pop() || m.sourceDirName;
      console.log(`  ${RED}unlink${RESET}  ${label}`);
      removed++;
    }
  }

  console.log(`\n  ${BOLD}Done:${RESET} ${removed} removed\n`);
}

function cmdStatus(): void {
  const localClaudeProjects = join(homedir(), ".claude", "projects");
  console.log(`\n${BOLD}claude-memory-bridge${RESET} — status\n`);

  if (!existsSync(localClaudeProjects)) {
    console.log(`  ${DIM}No .claude/projects/ directory.${RESET}\n`);
    return;
  }

  const entries = readdirSync(localClaudeProjects, { withFileTypes: true });
  let symlinks = 0, dirs = 0;

  for (const entry of entries) {
    const fullPath = join(localClaudeProjects, entry.name);
    const stat = lstatSync(fullPath);

    if (stat.isSymbolicLink()) {
      const target = readlinkSync(fullPath);
      const ok = existsSync(fullPath);
      console.log(`  ${CYAN}→${RESET} ${entry.name}`);
      console.log(`    ${target}  ${ok ? `${GREEN}ok${RESET}` : `${RED}broken${RESET}`}`);
      symlinks++;
    } else if (stat.isDirectory()) {
      console.log(`  ${DIM}■${RESET} ${entry.name}`);
      dirs++;
    }
  }

  console.log(`\n  ${symlinks} bridged, ${dirs} local\n`);
}

// --- CLI ---

function printUsage(): void {
  console.log(`
  ${BOLD}claude-memory-bridge${RESET} — Share Claude Code memory across systems

  ${BOLD}USAGE${RESET}

    claude-memory-bridge ${DIM}................${RESET} interactive wizard (auto-detects everything)
    claude-memory-bridge status ${DIM}..........${RESET} show current bridges
    claude-memory-bridge scan  ${DIM}[opts]${RESET} ${DIM}...${RESET} preview what would be linked
    claude-memory-bridge link  ${DIM}[opts]${RESET} ${DIM}...${RESET} create symlinks
    claude-memory-bridge unlink ${DIM}[opts]${RESET} ${DIM}..${RESET} remove symlinks

  ${BOLD}OPTIONS${RESET} ${DIM}(for scan/link/unlink)${RESET}

    --source <path>         remote .claude/projects/ directory
    --map <remote>=<local>  path prefix mapping

  ${BOLD}EXAMPLES${RESET}

    ${DIM}# Just run it — auto-detects mounted disks${RESET}
    claude-memory-bridge

    ${DIM}# Non-interactive: Arch Linux with WSL2 disk at /mnt/wsl2${RESET}
    claude-memory-bridge link --source /mnt/wsl2/home/user/.claude/projects --map '/home/user=/mnt/wsl2/home/user'
`);
}

function parseArgs(args: string[]): { command: string; source?: string; remotePrefix?: string; localPrefix?: string } {
  const command = args[0] || "wizard";
  let source: string | undefined;
  let remotePrefix: string | undefined;
  let localPrefix: string | undefined;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--source":
        source = args[++i];
        break;
      case "--map": {
        const map = args[++i];
        if (!map || !map.includes("=")) {
          console.error("--map requires format: remote_prefix=local_prefix");
          process.exit(1);
        }
        const eqIdx = map.indexOf("=");
        remotePrefix = map.slice(0, eqIdx);
        localPrefix = map.slice(eqIdx + 1);
        break;
      }
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
    }
  }

  return { command, source, remotePrefix, localPrefix };
}

function requireArgs(parsed: ReturnType<typeof parseArgs>) {
  if (!parsed.source) { console.error("Missing --source"); process.exit(1); }
  if (!parsed.remotePrefix || !parsed.localPrefix) { console.error("Missing --map"); process.exit(1); }
  return { source: parsed.source!, remotePrefix: parsed.remotePrefix!, localPrefix: parsed.localPrefix! };
}

// --- Main ---

const parsed = parseArgs(process.argv.slice(2));

switch (parsed.command) {
  case "wizard":
    await cmdWizard();
    break;
  case "scan": {
    const a = requireArgs(parsed);
    cmdScan(a.source, a.remotePrefix, a.localPrefix);
    break;
  }
  case "link": {
    const a = requireArgs(parsed);
    cmdLink(a.source, a.remotePrefix, a.localPrefix);
    break;
  }
  case "unlink": {
    const a = requireArgs(parsed);
    cmdUnlink(a.source, a.remotePrefix, a.localPrefix);
    break;
  }
  case "status":
    cmdStatus();
    break;
  case "help":
  case "--help":
  case "-h":
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${parsed.command}`);
    printUsage();
    process.exit(1);
}
