---
name: commit
description: Commit staged changes with a clear, conventional commit message. Use when the user asks to commit changes, wants staged work saved to git history, or invokes /commit.
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(make lint:*), Skill, AskUserQuestion
---

# Commit staged changes

## Steps

1. Run in parallel: `git status --short`, `git diff --staged`, and
   `git log --oneline -10` (for this repo's existing message style).
2. If nothing is staged:
   - If there are modified tracked files, stage them by name (never
     `git add -A` or `git add .` — name specific files) and confirm with
     the user what got staged before committing anything they didn't
     already stage themselves.
   - If there's nothing to commit at all, say so and stop.
3. Before committing, scan the staged file list for anything that looks
   like it could contain secrets (`.env`, `credentials.json`, API keys,
   private keys) even if the filename looks innocuous — check contents,
   not just the name. Warn and stop rather than committing if anything
   looks off.
4. Run `make lint`. If it fails, show the errors and stop — don't
   commit code that doesn't lint. Fixing lint errors happens outside
   this skill; re-run `/commit` once the fixes are staged.
5. Run the `review` skill (via the Skill tool) on the staged changes.
   It produces a report only — it never edits files. Then:
   - If the review comes back clean, continue to the commit.
   - If it reports findings, present the report and use
     `AskUserQuestion` to let the user choose:
     - **Fix findings first** — stop here. Apply the fixes as normal
       edits outside this skill, stage them, and re-run `/commit` so
       the fixed diff goes through the same lint + review gate.
     - **Commit as-is** — proceed to the commit despite the findings.
       Note in your final summary which findings were waved through,
       so they aren't silently forgotten.
6. Draft a commit message:
   - Lead with *why*, not a restatement of the diff — 1-3 sentences
     unless the change genuinely needs more.
   - Match this repo's existing style (see `git log`) rather than
     inventing a new format.
   - Don't enumerate files changed — that's what `git show` is for.
7. Commit using a heredoc so formatting survives, with a Co-Authored-By
   trailer for whichever model is running this command:

       git commit -m "$(cat <<'EOF'
       <message>

       Co-Authored-By: <model name> <noreply@anthropic.com>
       EOF
       )"

8. Run `git status --short` after to confirm the commit landed and the
   tree is otherwise clean.

## Rules

- Never `--amend`, `--no-verify`, `--no-gpg-sign`, or force anything. If
  a pre-commit hook fails, fix the issue and make a new commit instead.
- Never push. This command only commits locally.
- Never commit if step 3 turns up something suspicious — surface it and
  stop instead.
