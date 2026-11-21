"""Golden questions: how well the assistant answers, measured on a real graph.

Run against a live AI service and platform with the data-lake seed loaded
(``python -m backend.scripts.seed_data_lake``)::

    python -m backend.ai_service.evals --user <user id> --workspace <ws> \
        --data-source <ds> --view <view id> [--cases path.json]

Each case asks one question and checks what came back: which cards, which
entities in them, whether the assistant asked instead of guessing, which
words the answer used. It is informational — run it when the prompts, the
tools or the model change, and compare the pass rate — not a CI gate: a live
model is not deterministic.
"""
