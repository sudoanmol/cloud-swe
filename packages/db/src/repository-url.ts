const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const githubRepository = /^[A-Za-z0-9._-]+$/;
const branchComponent = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  if (
    !repository ||
    repository === "." ||
    repository === ".." ||
    repository.length > 100 ||
    !githubOwner.test(owner) ||
    !githubRepository.test(repository)
  )
    return null;

  return `https://github.com/${owner}/${repository}.git`;
}

export function normalizePublicGitHubBranch(value: string): string | null {
  const branch = value.trim();
  if (!branch || branch.length > 255) return null;

  if (
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("@{")
  )
    return null;

  const components = branch.split("/");
  if (
    components.some((component) => component.endsWith(".lock") || !branchComponent.test(component))
  )
    return null;
  return branch;
}
