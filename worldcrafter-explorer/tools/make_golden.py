"""Regenerate test/fixtures/golden.json from the official WorldCrafter camera code.

Usage: python tools/make_golden.py /path/to/WorldCrafter-checkout
Needs only numpy. The fixture stores every 8th frame (plus the last) of each
trajectory so the JS port can be checked against the reference implementation.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from worldcrafter.camera import build_trajectory, count_chunks, parse_trajectory  # noqa: E402

SCRIPTS = [
    "forward1",
    "forward1x2\nyaw_right45x2",
    "f1 b1 l1 r1 up1 down1",
    "yl30 yr30 pu15 pd15",
    "orbit_left15x3\norbit_up10",
    "@orbit_radius 0\norbit_right30",
    "@orbit_radius 3\norbit_left20 forward1 orbit_left20",
    "forward2&right2&yaw_left45",
    "f1 & yl30 & pu10",
    "forward1 yaw_left30 reverse2",
    "forward1x2 reverse_frames2",
    "@sampling smooth_turns\nyaw_left30x3 forward1x2",
    "@last_frame include\nforward1 yaw_right30",
    "@sampling smooth_turns\n@last_frame include\nforward1 reverse1",
    "pitch_up90 forward1",
    "forward5 right0.5",
    "# comment only line\nforward1  # trailing comment\n",
    "Forward1X2",
    "forward6",
    "bogus1",
    "reverse1",
    "forward1&forward2",
    "orbit_left15&forward1",
    "@orbit_radius 3\norbit_left120",
    "forward1\n@sampling smooth_turns",
    "@sampling fast\nforward1",
    "",
    "forward4&right4",
]


def main():
    cases = []
    for text in SCRIPTS:
        try:
            events, options = parse_trajectory(text)
            camera, _ = build_trajectory(events, **options)
            frames = sorted(set(range(0, len(camera), 8)) | {len(camera) - 1})
            cases.append({
                "script": text, "events": events, "options": options,
                "chunks": count_chunks(events), "num_frames": len(camera),
                "frames": {str(i): [[round(v, 12) for v in row] for row in camera[i, :3, :4].tolist()] for i in frames},
            })
        except Exception as exc:  # noqa: BLE001 - errors are part of the contract
            cases.append({"script": text, "error": str(exc)})
    out = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "golden.json"
    out.write_text(json.dumps(cases, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {out}")


if __name__ == "__main__":
    main()
