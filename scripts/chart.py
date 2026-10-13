"""Pass rate per task family and model, from harness run folders, as a PNG bar chart.

Usage: python scripts/chart.py out.png "Label=run/dir" "Label=run/dir" ...

Off-script runs are left out: the scripted customer could not follow the agent, so they say
nothing about the agent.
"""

import json
import re
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

FAMILIES = [
    ("Opening accounts", r"^open_account_"),
    ("Best interest", r"^open_best_interest"),
    ("Fee refunds", r"^fee_"),
    ("Transfers", r"^transfer_"),
    ("Interest checks", r"^interest_"),
    ("Hand to a human", r"^(report_|request_)"),
]


def load(run_dir: str) -> list[dict]:
    runs = [json.loads(p.read_text()) for p in Path(run_dir).glob("*.json") if p.name != "meta.json"]
    return [r for r in runs if r["result"]["evaluation"]["endReason"] != "off_script"]


def rate(runs: list[dict], pattern: str | None) -> tuple[int, int]:
    picked = [r for r in runs if pattern is None or re.search(pattern, r["task"]["template"])]
    return sum(r["result"]["evaluation"]["pass"] for r in picked), len(picked)


def main() -> None:
    out, *specs = sys.argv[1:]
    models = [(label, load(d)) for label, d in (s.split("=", 1) for s in specs)]
    rows = [("All tasks", None), *FAMILIES]

    fig, ax = plt.subplots(figsize=(8, 0.55 * len(rows) * max(2, len(models)) / 2 + 1.2))
    height = 0.8 / len(models)
    for k, (label, runs) in enumerate(models):
        stats = [rate(runs, p) for _, p in rows]
        ys = [i + k * height for i in range(len(rows))]
        values = [100 * p / n if n else 0 for p, n in stats]
        ax.barh(ys, values, height=height * 0.9, label=label)
        for y, v, (p, n) in zip(ys, values, stats):
            ax.text(v + 1, y, f"{v:.0f}% ({p}/{n})", va="center", fontsize=8)
        print(f"{label}: " + ", ".join(f"{name} {p}/{n}" for (name, _), (p, n) in zip(rows, stats)))

    ax.set_yticks([i + height * (len(models) - 1) / 2 for i in range(len(rows))])
    ax.set_yticklabels([name for name, _ in rows])
    ax.invert_yaxis()
    ax.set_xlim(0, 115)
    ax.set_xlabel("Pass rate (%)")
    ax.set_title("Pass rate by task family (scripted customer)")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=len(models), fontsize=8, frameon=False)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    fig.tight_layout()
    fig.savefig(out, dpi=150)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
