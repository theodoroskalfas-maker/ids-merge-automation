# Job Merge Automation — How It Works

## What does this do?

When a Field Work Cycle (Bezoekronde) contains thousands of locations, the system needs to create or update a **Locatiebezoek** (visit record) for each location and link all related **Jobs** to it. This automation handles that process automatically.

In simple terms: **one click merges all Jobs into visit records for an entire Field Work Cycle, no matter how large it is.**

## Why was this built?

Zoho CRM has built-in limits on how long a single operation can run (maximum 5 minutes). For a Field Work Cycle with 4,000+ locations, processing everything in one go would take much longer than that — causing the operation to fail partway through.

This automation solves that problem by running the process outside of Zoho CRM, where those time limits don't apply. It processes each location one at a time, reliably, until every single one is done.

## How does it work?

1. A user clicks the **"Merge Jobs"** button on a Field Work Cycle record in Zoho CRM
2. This triggers an automated process that runs in the background (on GitHub Actions)
3. The system retrieves all locations for that Field Work Cycle
4. For each location, it creates or updates a Locatiebezoek record and links the relevant Jobs
5. When the process finishes, the results are written back to the Field Work Cycle record in the **Last Merge Result** field

The user does not need to keep their browser open or wait — the process runs independently and updates the CRM record when it's done.

## What do the results look like?

After completion, the **Last Merge Result** field on the Field Work Cycle shows a summary:

```
Merge completed: 2026-06-19T14:30:00Z
FWC: Y26R03
Total locations: 3976
Created: 3298
Updated: 678
Skipped: 0
Jobs linked: 14814
Errors: 0
Status: SUCCESS
```

- **Created** — new Locatiebezoek records that were created
- **Updated** — existing Locatiebezoek records that were updated with new Job links
- **Skipped** — locations with no Jobs to process
- **Jobs linked** — total number of Jobs connected to their Locatiebezoek records
- **Errors** — any locations that could not be processed (with details)

## How long does it take?

Approximately **20–30 minutes** for a Field Work Cycle with ~4,000 locations. The process is deliberately paced to avoid overloading the system.

## Is it safe to run multiple times?

Yes. The process is **idempotent** — running it again on the same Field Work Cycle will simply update existing records rather than creating duplicates. This means it's safe to re-run if needed, for example after adding new locations to a cycle.

## Who maintains this?

This automation was built and is maintained by REBORRN. For questions or issues, contact the development team.
