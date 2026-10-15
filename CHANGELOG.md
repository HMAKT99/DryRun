# Changelog

## Unreleased
- Reports now say *why* the sandbox is unavailable (daemon not reachable vs. image not pulled, with the exact `docker pull`).
- Removed the unused `productionHints` config option (it was documented but not wired to anything).
- Docs: install requirements, credentials setup for the MCP server, SECURITY.md, issue/PR templates.

## 0.1.1
Fixes from an end-to-end audit. **Upgrade recommended: 0.1.0 could report `safe` for a few commands that write files.**

- shell: `git log/diff --output=…`, `sort -o`, `rg --pre`, `tree -o`, `hostname <name>`, `date -s` are no longer treated as read-only.
- shell: `sudo -u root …`, `nice -n N …`, `env -u X …` are unwrapped, so catastrophic commands behind them are blocked.
- shell: `git -C <dir> …` and `git -c k=v …` are parsed; `git -C <dir> push --force` now gets the remote analysis.
- shell: paths inside the project under `/var`, `/usr/src/app` etc. are no longer flagged as system directories (read-only commands can be `safe` there).
- shell: copying or moving files into `~` is `confirm`, not a hard block; `2>&1` is not a file write.
- shell: specific findings for `terraform destroy/apply`, `kubectl delete`, `docker prune/rm`, `aws … rm/delete`, `gh repo delete`, `psql -c "DROP …"`, `dropdb`, `redis-cli flushall`.
- stripe: fixed an estimate that doubled the total beyond the 3,000-lookup cap.
- core: the report path can no longer crash on hostile input; sandbox size check stops early on huge directories.
- engine: `.dryrun/` ignores itself in git; Terraform parse errors never echo file contents.
- `--version` now reports the package version.

## 0.1.0
First release.
