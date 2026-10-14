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
    runs = [json.loads(p.read_text(encoding="utf-8")) for p in Path(run_dir).glob("*.json") if p.name != "meta.json"]
    return [r for r in runs if r["result"]["evaluation"]["endReason"] != "off_script"]


def rate(runs: list[dict], pattern: str | None) -> tuple[int, int]:
    picked = [r for r in runs if pattern is None or re.search(pattern, r["task"]["template"])]
    return sum(r["result"]["evaluation"]["pass"] for r in picked), len(picked)


# Categorical slots in fixed order: model k always gets color k.
COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]


def main() -> None:
    out, *specs = sys.argv[1:]
    models = [(label, load(d)) for label, d in (s.split("=", 1) for s in specs)]
    rows = [("All tasks", None), *FAMILIES]

    fig, ax = plt.subplots(figsize=(1.5 + 0.32 * len(rows) * len(models), 5))
    width = 0.84 / len(models)
    for k, (label, runs) in enumerate(models):
        stats = [rate(runs, p) for _, p in rows]
        xs = [i + (k - (len(models) - 1) / 2) * width for i in range(len(rows))]
        values = [100 * p / n if n else 0 for p, n in stats]
        total_p, total_n = stats[0]
        ax.bar(xs, values, width=width, color=COLORS[k % len(COLORS)], edgecolor="white", linewidth=1,
               label=f"{label} ({total_p}/{total_n})")
        for x, v in zip(xs, values):
            ax.text(x, v + 1.5, f"{v:.0f}", ha="center", va="bottom", fontsize=6.5, color="#3d3d3a")
        print(f"{label}: " + ", ".join(f"{name} {p}/{n}" for (name, _), (p, n) in zip(rows, stats)))

    ax.set_xticks(range(len(rows)))
    ax.set_xticklabels([name.replace(" ", "\n", 1) if len(name) > 12 else name for name, _ in rows], fontsize=9)
    ax.set_ylim(0, 108)
    ax.set_ylabel("Pass rate (%)")
    ax.yaxis.grid(True, color="#e6e5e0", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.set_title("Pass rate by task family (scripted customer)")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.14), ncol=len(models), fontsize=8, frameon=False)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.tick_params(axis="y", length=0)
    fig.tight_layout()
    fig.savefig(out, dpi=150)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
