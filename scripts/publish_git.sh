#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Usage:
  scripts/publish_git.sh -m "commit message" [options]

Options:
  -m, --message TEXT   Commit message (required)
  -a, --all            Stage all changes, including untracked files (git add -A)
  -t, --tracked        Stage only tracked changes (git add -u) [default]
  -r, --remote NAME    Git remote name [default: origin]
  -b, --branch NAME    Branch to publish (must be current branch)
      --no-push        Commit only, do not push
  -h, --help           Show this help

Examples:
  scripts/publish_git.sh -m "feat: update exporter"
  scripts/publish_git.sh -m "chore: publish release" --all
  scripts/publish_git.sh -m "fix: parser naming" --no-push
EOF
}

require_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: current directory is not inside a git repository." >&2
    exit 1
  fi
}

MESSAGE=""
STAGE_MODE="tracked"
REMOTE_NAME="origin"
TARGET_BRANCH=""
PUSH_AFTER_COMMIT="yes"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      [[ $# -lt 2 ]] && { echo "Error: missing value for $1." >&2; exit 1; }
      MESSAGE="$2"
      shift 2
      ;;
    -a|--all)
      STAGE_MODE="all"
      shift
      ;;
    -t|--tracked)
      STAGE_MODE="tracked"
      shift
      ;;
    -r|--remote)
      [[ $# -lt 2 ]] && { echo "Error: missing value for $1." >&2; exit 1; }
      REMOTE_NAME="$2"
      shift 2
      ;;
    -b|--branch)
      [[ $# -lt 2 ]] && { echo "Error: missing value for $1." >&2; exit 1; }
      TARGET_BRANCH="$2"
      shift 2
      ;;
    --no-push)
      PUSH_AFTER_COMMIT="no"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

if [[ -z "$MESSAGE" ]]; then
  echo "Error: commit message is required." >&2
  print_usage
  exit 1
fi

require_git_repo
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" == "HEAD" ]]; then
  echo "Error: detached HEAD is not supported. Checkout a branch first." >&2
  exit 1
fi

if [[ -n "$TARGET_BRANCH" && "$TARGET_BRANCH" != "$CURRENT_BRANCH" ]]; then
  echo "Error: branch mismatch. Current branch is '$CURRENT_BRANCH', requested '$TARGET_BRANCH'." >&2
  exit 1
fi

if [[ "$STAGE_MODE" == "all" ]]; then
  git add -A
else
  git add -u
fi

if git diff --cached --quiet; then
  echo "No staged changes to commit."
  if [[ "$STAGE_MODE" == "tracked" ]]; then
    echo "Tip: run with --all if you need to include new files."
  fi
  exit 1
fi

git commit -m "$MESSAGE"

if [[ "$PUSH_AFTER_COMMIT" == "yes" ]]; then
  if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    echo "Error: remote '$REMOTE_NAME' not found." >&2
    exit 1
  fi
  git push -u "$REMOTE_NAME" "$CURRENT_BRANCH"
fi

echo "Done."
