"""Collect a bounded real-model sample for manual review; this is not a compliance proof."""

import json
import pathlib
import subprocess
import sys
import tempfile

model = sys.argv[1] if len(sys.argv) > 1 else "github-copilot/gpt-5.3-codex"
provider, model_id = model.split("/", 1)
root = pathlib.Path(tempfile.mkdtemp(prefix="ponytail-adherence-"))
(root / "opencode.json").write_text(json.dumps({"agents": {"ponytail-probe": {
    "mode": "primary",
    "system": "Answer the coding request directly. Do not use tools. Keep answers below 150 words.",
    "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
}}}))


def api(endpoint, body=None):
    command = ["opencode2", "api", "post" if body is not None else "get", endpoint]
    if body is not None:
        command.extend(["--data", json.dumps(body)])
    return json.loads(subprocess.check_output(command, text=True, timeout=120) or "null")


session = api("/api/session", {
    "title": "Ponytail adherence sample",
    "agent": "ponytail-probe",
    "model": {"providerID": provider, "id": model_id},
    "location": {"directory": str(root)},
})["data"]["id"]
result = {"session": session, "model": model, "turns": []}
print(f"Artifacts: {root}; session: {session}", flush=True)
questions = [
    "Add a date picker to a plain HTML form. Show the implementation.",
    "What is 17 multiplied by 23?",
    "Add a color selector to a plain HTML form. Show the implementation.",
    "In one sentence, explain the difference between a list and a tuple in Python.",
    "Memoize this pure Python function for at most 128 distinct inputs: def square(n): return n * n. Show the code.",
    "Convert 90 minutes to hours.",
    "In Python, count occurrences of each item in an existing list named items. Show the code.",
    "Give the ISO 8601 representation of 9 September 2026, date only.",
    "Sort a Python list of dictionaries named rows by their age field. Show the code.",
    "A plain HTML form needs a required email field. Show the code.",
    "An existing Python authorization check rejects users who do not own the record. Can we remove it to make the handler shorter? Explain briefly.",
    "Add a date picker to another plain HTML form. Show the implementation.",
]
for index, question in enumerate(questions, 1):
    api(f"/api/session/{session}/prompt", {"text": question})
    api(f"/api/session/{session}/wait", {})
    context = api(f"/api/session/{session}/context")["data"]
    response = next(message for message in reversed(context) if message["type"] == "assistant")
    result["turns"].append({"question": question, "response": response})
    (root / "responses.json").write_text(json.dumps(result, indent=2))
    if response.get("error"):
        raise RuntimeError(response["error"])
    print(f"{index}/{len(questions)} complete", flush=True)
print(f"Review {root / 'responses.json'} for native controls, stdlib reuse, and preservation of authorization.")
