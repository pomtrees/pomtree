# Running the setup interview

`node packages/pomtreed/src/main.ts init --questions --json --repo <repo>` (with the target repository the user named; see SKILL.md) prints every setup question: its name, its prompt text, its kind and, where one exists, its default. Run it once and keep the output.

For each question, in the order printed:

1. Ask it in plain words. Explain the tradeoff from the question's prompt text; do not add facts the prompt does not give, and point to `docs/configuration.md` when the user wants more.
2. Record the user's answer. If the question has a default, offer it as a default and let the user take it or change it.
3. The safety questions (the egress proxy image, untemplated egress, extensions approval) have no default. Never invent one and never pick one to keep things moving. If the user is unsure, explain the options and wait.
4. The model key is never asked for. The answers file names the key file's absolute path; the user puts the key into that file with their own editor.

Then write the answers file (JSON) in the shape `GETTING_STARTED.md` gives for the configure step, using the names exactly as the questions printed them. Run `init --answers FILE --repo <repo>` (a dry run) and show the user the diff and any validation error. Fix errors by asking the user again, not by guessing. Ask before running the same command with `--write`. A refusal (exit 2) means a differing file exists or the key file would be overwritten: show it to the user and let them decide.
