# Instructions for coding agents

Follow `CONTRIBUTING.md`: it holds the layering, where code goes, the rules that protect users, the tests, the gates to run before a commit and the writing conventions. `README.md` gives the overview and `docs/` the details of behavior, configuration, deployment and operations; keep them in line with the code you change.

- Never read, print or commit `.env` or any other file with credentials; use `.env.example` for the names of the settings.
- Run tests against a throwaway database only, never a shared or production one.
- Do not write to Jira, Wire or a model endpoint of a real deployment without the operator's approval.
