# Contributing

Thanks for helping. The library is a set of reference SaaS building blocks (auth, billing, webhooks,
RBAC, ...) implemented in eight languages against a shared contract. Many suites still fail, and fixing
them is the most useful contribution.

## Ground rules

- **One system + one language per pull request.** It keeps review small.
- **Never weaken or delete a test to make it pass.** If a test is wrong, say why in the PR.
- If a suite starts passing, remove its line from `ci/baseline.json` in the same PR.
- All languages of a system should behave the same for the same input; check the spec in `docs/`.

## Sign-off (DCO)

Every commit must carry a `Signed-off-by:` line, certifying the
[Developer Certificate of Origin](https://developercertificate.org/):

    git commit -s -m "go/webhooks: fix signature check"

Forgot? `git commit --amend -s` (last commit) or `git rebase --signoff main` (a branch).
Contributions are licensed under Apache-2.0, as is the rest of the repository.

## Running tests

Layout: `saas_templates/<lang>/<system>_<lang>.<ext>` is the implementation and
`<system>_<lang>_tests.<ext>` its tests. One runner covers every language:

    python tools/run_suites.py --lang <lang>                      # all systems
    python tools/run_suites.py --lang <lang> --systems webhooks   # one system

It installs each language's packages into `.deps/` on first use (git-ignored) and needs only the
language toolchain and network access:

| Language | You need | Packages via |
|---|---|---|
| python | Python 3.10+ | pip |
| javascript, typescript | Node 22+ | npm |
| go | Go 1.22+, a C compiler (sqlite3) | Go modules |
| java | JDK 21, Maven | Maven Central |
| php | PHP 8.2+ with `pdo_sqlite`, Composer | Composer |
| csharp | .NET 8 SDK | NuGet |
| rust | stable Rust | crates.io |

## Pull requests

CI runs all eight languages and shows a per-suite table in each job's summary. It fails only on a
regression against `ci/baseline.json`. Please fill in the PR template.

## Conduct and security

Be kind: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security issues go through
[SECURITY.md](SECURITY.md), not public issues.
