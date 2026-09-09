const githubName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const branchComponent = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const forbiddenBranchCharacters = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

export function normalizePublicGitHubUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const owner = parts.at(0);
  const rawRepository = parts.at(1);
  if (!owner || !rawRepository || parts.length !== 2) return null;

  const repository = rawRepository.endsWith(".git")
    ? rawRepository.slice(0, -".git".length)
    : rawRepository;
  if (!repository || !githubName.test(owner) || !githubName.test(repository)) return null;

  return `https://github.com/${owner}/${repository}.git`;
}

export function normalizePublicGitHubBranch(value: string): string | null {
  const branch = value.trim();
  if (!branch || branch.length > 255 || branch.startsWith("-") || branch.startsWith("/"))
    return null;
  const hasForbiddenCharacter = [...branch].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f || forbiddenBranchCharacters.has(character);
  });
  if (
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    hasForbiddenCharacter
  )
    return null;

  const components = branch.split("/");
  if (
    components.some((component) => component.endsWith(".lock") || !branchComponent.test(component))
  )
    return null;
  return branch;
}
