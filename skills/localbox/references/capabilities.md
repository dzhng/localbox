# Capabilities

The installed CLI is the source of truth; this skill may be newer or older than
it. Ask the CLI instead of assuming an operation exists.

```sh
localbox help                    # every command, grouped, with a one-line description
localbox help sandbox.create     # one operation: usage line, description, input schema
localbox sandbox create --help   # the same, from the command you were about to run
localbox help --json             # the whole catalog as JSON
```

Each catalog operation id (`sandbox.create`, `fs.read`, `skill.status`) is a
command (`localbox sandbox create`, `localbox fs read`, `localbox skill status`)
and an MCP tool of the same name with the same schema. Flags are the schema's
fields (`--memory 4G` and `--sleep-after 30m` take sizes and durations). For
input that is awkward as flags, pass the schema's JSON directly:

```sh
localbox invoke fs.read --sandbox NAME --input-json '{"path":"/var/log/syslog","offset":0,"length":65536}'
```

A change through `invoke` needs `--mutation-id ID` (other commands make one up).
Repeating a change with the same id returns the first result instead of acting
twice.
