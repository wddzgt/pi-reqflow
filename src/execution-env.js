export function childEnvironment(names, includeHome = false, credentials = {}) {
  if (!Array.isArray(names)) throw new Error("Child process environment allowlist is required");
  const environment = Object.create(null);
  const runtime = ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "SystemRoot", "ComSpec"];
  if (includeHome) runtime.push("HOME", "USER", "LOGNAME");
  for (const name of runtime) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  for (const name of names) {
    if (typeof name !== "string" || name.toUpperCase().startsWith("REQFLOW_")
        || ["NODE_OPTIONS", "NODE_TEST_CONTEXT"].includes(name.toUpperCase())) {
      throw new Error(`Child environment variable is reserved: ${name}`);
    }
    const value = Object.hasOwn(credentials, name) ? credentials[name] : process.env[name];
    if (value === undefined) throw new Error(`Configured child environment variable is missing: ${name}`);
    environment[name] = value;
  }
  return environment;
}
