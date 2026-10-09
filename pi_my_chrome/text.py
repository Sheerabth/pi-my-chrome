"""Text helper backed by the harness LLM (Pi/Claude), not a tiny extra model.

jev-ultrafast calls field_text(context) only when the chosen operation is
TYPE_TEXT. Upstream needs TEXT_MODEL_API_KEY; here the harness supplies the
string because it already knows the goal. Signature matches upstream so it
can be injected via `A.field_text = pi_field_text` with no fork.
"""

from __future__ import annotations

from typing Any, Callable

FieldTextFn = Callable[[dict], tuple[str, dict]]


def make_pi_field_text(ask_harness: Callable[[str], str]) -> FieldTextFn:
    """Build a field_text(context) that asks Pi/Claude for the value to type."""

    def pi_field_text(context: dict) -> tuple[str, dict]:
        goal = context.get("goal", "")
        field = context.get("field", {})
        prompt = (
            "Return ONLY the exact string to type into this browser field. No quotes, no explanation.\n"
            f"Goal: {goal}\nField: {field.get('label')} (role={field.get('role')}, current={field.get('value')!r})\n"
            f"Page: {context.get('page', {}).get('title')}\n"
        )
        value = ask_harness(prompt).strip()
        if not value or len(value) > 2000:
            raise ValueError("Harness returned no valid field value; nothing typed.")
        return value, {"model": "pi-harness"}

    return pi_field_text


def default_pi_field_text(context: dict[str, Any]) -> tuple[str, dict]:
    raise ValueError(
        "TYPE_TEXT needs a harness text callback — pass make_pi_field_text(ask) "
        "to browser_run(). No text is hardcoded or guessed."
    )
