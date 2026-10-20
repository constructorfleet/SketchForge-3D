"""``python -m sketchforge3d <file>``, the same runner as ``sketchforge-macro``."""

from ._macro import main

if __name__ == "__main__":
    raise SystemExit(main())
