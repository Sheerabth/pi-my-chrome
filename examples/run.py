"""Example: run one goal. Harness text via stdin (replace with Pi/Claude call)."""

import argparse

from pi_my_chrome import browser_run


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--goal", required=True)
    args = ap.parse_args()

    def ask(prompt: str) -> str:
        print(prompt)
        return input("TYPE_TEXT value: ")

    for state in browser_run(args.url, args.goal, ask):
        print(state.get("elapsed_ms"), state.get("status"))


if __name__ == "__main__":
    main()
