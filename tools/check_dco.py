#!/usr/bin/env python3
"""Fail when a commit in a pull request lacks a Developer Certificate of Origin sign-off by its author.

LIFESPAN: permanent -- the `dco` check (.github/workflows/dco.yml); see CONTRIBUTING.md "Sign-off (DCO)".

Rule (the one the DCO GitHub App applies): every non-merge commit in BASE..HEAD carries a trailer
`Signed-off-by: Name <email>` whose email equals the commit's author email, ignoring case. Commits whose author
name ends in `[bot]` (GitHub's own bots, e.g. Dependabot) are exempt. For each commit that fails it prints the
short hash, the subject and why -- never an email address, since the log is public.

Usage:
  python tools/check_dco.py BASE_SHA HEAD_SHA
Exit code: 0 = every commit is signed off by its author, 1 = at least one is not, 2 = usage or git error.
"""
from __future__ import annotations

import re
import subprocess
import sys

SIGNOFF = re.compile(r"^Signed-off-by:[ \t]*(?P<name>.*?)[ \t]*<(?P<email>[^<>\s]+)>[ \t]*$", re.I | re.M)


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def unsigned(base: str, head: str) -> list[tuple[str, str, str]]:
    """(short sha, subject, reason) for every non-merge commit in base..head without its author's sign-off."""
    failures = []
    for sha in git("rev-list", "--no-merges", "--reverse", f"{base}..{head}").split():
        author_name, author_email, body = git("show", "-s", "--format=%an%x00%ae%x00%B", sha).split("\x00", 2)
        if author_name.endswith("[bot]"):
            continue
        signed = {m.group("email").lower() for m in SIGNOFF.finditer(body)}
        if author_email.strip().lower() in signed:
            continue
        subject = body.strip().splitlines()[0][:72] if body.strip() else "(no message)"
        reason = "no Signed-off-by line" if not signed else "Signed-off-by does not match the commit's author email"
        failures.append((sha[:12], subject, reason))
    return failures


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    try:
        failures = unsigned(argv[1], argv[2])
    except subprocess.CalledProcessError as exc:
        print(f"dco: git failed: {exc.stderr.strip()}")
        return 2
    if not failures:
        print("dco: every commit is signed off by its author.")
        return 0
    print(f"dco: {len(failures)} commit(s) without a matching Signed-off-by line:")
    for sha, subject, reason in failures:
        print(f"  {sha}  {subject}  ({reason})")
    print("\nFix: sign off with the same name and email you commit with, then force-push your branch:\n"
          "  git commit --amend -s --no-edit     # the last commit\n"
          "  git rebase --signoff origin/main    # every commit on the branch\n"
          "See CONTRIBUTING.md, \"Sign-off (DCO)\".")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
