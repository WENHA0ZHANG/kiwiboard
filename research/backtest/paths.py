"""Where the backtest keeps downloaded data and results (git-ignored)."""
import os

WORK = os.environ.get("KB_RESEARCH_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
