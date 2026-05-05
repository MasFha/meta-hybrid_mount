import { shellEscapeDoubleQuoted } from "./shell";

function pickHereDocTag(content: string): string {
  let tag = `__CLAUDE_EOF_${Date.now()}__`;
  while (content.includes(tag)) {
    tag = `${tag}_X`;
  }
  return tag;
}

export async function readOptionalTextFile(
  runCommand: (command: string) => Promise<{ errno: number; stdout: string }>,
  path: string,
): Promise<string | null> {
  const { errno, stdout } = await runCommand(
    `cat "${shellEscapeDoubleQuoted(path)}" 2>/dev/null`,
  );
  return errno === 0 ? stdout : null;
}

export async function fileExists(
  runCommand: (command: string) => Promise<{ errno: number }>,
  path: string,
): Promise<boolean> {
  const { errno } = await runCommand(
    `[ -e "${shellEscapeDoubleQuoted(path)}" ]`,
  );
  return errno === 0;
}

export async function listDirectories(
  runCommandExpectOk: (command: string) => Promise<string>,
  path: string,
): Promise<string[]> {
  const output = await runCommandExpectOk(
    `[ -d "${shellEscapeDoubleQuoted(path)}" ] || exit 0; find "${shellEscapeDoubleQuoted(path)}" -mindepth 1 -maxdepth 1 -type d -print`,
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function writeTextFileAtomic(
  runCommandExpectOk: (command: string) => Promise<string>,
  dirname: (path: string) => string,
  path: string,
  content: string,
): Promise<void> {
  const parent = dirname(path);
  const tmpPath = `${path}.claude-tmp-${Date.now()}`;
  const tag = pickHereDocTag(content);
  await runCommandExpectOk(
    `mkdir -p "${shellEscapeDoubleQuoted(parent)}"
cat <<'${tag}' > "${shellEscapeDoubleQuoted(tmpPath)}"
${content}
${tag}
mv "${shellEscapeDoubleQuoted(tmpPath)}" "${shellEscapeDoubleQuoted(path)}"`,
  );
}
