#!/usr/bin/env python3
"""Fail when a commit in a pull request lacks a Developer Certificate of Origin sign-off.

LIFESPAN: permanent -- the `dco` check (.github/workflows/dco.yml); see CONTRIBUTING.md "Sign-off (DCO)".

Rule: every non-merge commit in BASE..HEAD carries a line `Signed-off-by: Name <email>` whose email is the commit's
author email or its committer email, ignoring case. As with the DCO GitHub App, a sign-off by the author or by the
committer counts and the line can sit anywhere in the message. Unlike the App, only the email has to match (names
are spelled in many ways), and commits whose author NAME ends in `[bot]` (bots such as Dependabot) are skipped.
For each commit that fails it prints the short hash, the subject and why -- never an email address, since the log
is public.

Usage:
  python tools/check_dco.py BASE_SHA HEAD_SHA
Exit code: 0 = every commit is signed off, 1 = at least one is not, 2 = usage or git error.

[2026-10-01 07:13 UTC] Review fixes: the sign-off pattern no longer backtracks on a long run of blanks (it took
seconds per 1,600 blanks before; a commit message is the PR author's to choose); a committer's sign-off counts; the
fix commands use the pull request's own base and reset the author; non-UTF-8 messages no longer crash the check.
"""
from __future__ import annotations

import re
import subprocess
import sys

# Linear on any input: one greedy run to the last `<` on the line (the name is not needed, only the email).
SIGNOFF = re.compile(r"^Signed-off-by:.*<(?P<email>[^<>\s]+)>[ \t]*$", re.I | re.M)


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True,
                          encoding="utf-8", errors="replace").stdout


def unsigned(base: str, head: str) -> list[tuple[str, str, str]]:
    """(short sha, subject, reason) for every non-merge commit in base..head without a matching sign-off."""
    failures = []
    for sha in git("rev-list", "--no-merges", "--reverse", f"{base}..{head}").split():
        author_name, author_email, committer_email, body = \
            git("show", "-s", "--format=%an%x00%ae%x00%ce%x00%B", sha).split("\x00", 3)
        if author_name.endswith("[bot]"):
            continue
        signed = {m.group("email").lower() for m in SIGNOFF.finditer(body)}
        if {author_email.strip().lower(), committer_email.strip().lower()} & signed:
            continue
        subject = body.strip().splitlines()[0][:72] if body.strip() else "(no message)"
        reason = ("no Signed-off-by line" if not signed
                  else "Signed-off-by matches neither the author's nor the committer's email")
        failures.append((sha[:12], subject, reason))
    return failures


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    base, head = argv[1], argv[2]
    try:
        failures = unsigned(base, head)
    except subprocess.CalledProcessError as exc:
        print(f"dco: git failed: {exc.stderr.strip()}")
        return 2
    if not failures:
        print("dco: every commit is signed off.")
        return 0
    print(f"dco: {len(failures)} commit(s) without a matching Signed-off-by line:")
    for sha, subject, reason in failures:
        print(f"  {sha}  {subject}  ({reason})")
    print("\nFix: set git's user.name and user.email to the name and email you sign off with, then re-sign your\n"
          "commits as yourself and force-push the branch:\n"
          "  git commit --amend --no-edit --reset-author -s                          # the last commit\n"
          f"  git rebase --exec 'git commit --amend --no-edit --reset-author -s' {base[:12]}"
          "   # every commit in this pull request\n"
          "See CONTRIBUTING.md, \"Sign-off (DCO)\".")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
