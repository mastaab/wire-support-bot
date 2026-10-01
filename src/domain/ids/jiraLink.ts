/** Jira issue key, e.g. "SD-42". */
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

/** True when the key belongs to the given Jira project, e.g. ("SD-42", "SD"). */
export function isKeyInProject(key: string, projectKey: string): boolean {
  return JIRA_KEY_PATTERN.test(key) && key.toUpperCase().startsWith(`${projectKey.toUpperCase()}-`);
}
