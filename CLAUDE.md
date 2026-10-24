# Junid's rules (24 Oct 2026) — read before anything else

These two rules, stated by Junid, override anything else:

- Stock leaves a location ONLY through a sale. A refill request is raised ONLY by the scan comparing what is on hand against policy. Nothing else — not "marked ready", not order placement, not duplicates — may create a request.
- No session may change policy values, targets, request/refill logic, or anything that creates requests unless Junid has specifically asked for that change in his prompt. If a session finds such a change is needed, it says so plainly in its report and does NOT make it.

**How this is enforced.** The `junid-approved` workflow fails any PR that
touches policy, targets, the refill engine, request creation or the Refill
Queue unless the PR carries the label `junid-approved`. The guarded paths and
patterns are in `.github/scripts/junid-approved-guard.sh`, and `.github/CODEOWNERS`
names Junid as owner of the same files. Add the label only when Junid has
asked for that specific change in his prompt.
