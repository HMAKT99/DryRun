---
name: Wrong verdict (confirm too strict, block too strict, missing finding)
about: Dry Run's verdict or findings were not what you expected. For a wrong `safe`, use a private security advisory instead (see SECURITY.md).
labels: verdict
---

**Action rehearsed** (redact secrets):
```
dryrun shell "..."   # or sql / tf / api / saas
```

**Verdict you got** (`safe` / `confirm` / `block`) and the headline effect:

**Verdict you expected, and why:**

**Report JSON** (`--json`, secrets redacted) or the report card:

**Environment:** Dry Run version (`dryrun --version`), OS, Docker yes/no.
