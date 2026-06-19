# IDS Merge Automation

Merges "Job" records into "Locatiebezoek" (visit) records in Zoho CRM for a field marketing system.

## Why this exists

Zoho CRM has hard execution limits: 5-minute timeout for button/API-triggered functions and a 200,000 Deluge-statement cap per execution. Processing thousands of locations in one CRM function is impossible under these limits.

This repo runs the looping logic on GitHub Actions instead. It calls two small Zoho CRM standalone functions via REST API — each processing exactly one location, well within Zoho's limits — in a sequential loop with retry logic and progress reporting.

### The two Zoho CRM functions (already built, live in Zoho)

| Function | Purpose | Returns |
|----------|---------|---------|
| `get_locations_for_merge` | Fetches all location IDs for a Field Work Cycle | `fwcName`, `locationCount`, `locationIds[]` |
| `merge_single_location` | Processes one location (creates/updates a Locatiebezoek record, links Jobs) | `status`, `action`, `jobsLinked` |

## Setup

### 1. Set the Zoho API key as a GitHub secret

Via the GitHub UI: **Settings > Secrets and variables > Actions > New repository secret**

- Name: `ZOHO_API_KEY`
- Value: your Zoho CRM API key (zapikey)

Or via the CLI:

```bash
gh secret set ZOHO_API_KEY
```

### 2. Trigger a run

**From the GitHub UI:** Go to the **Actions** tab > select "Merge Jobs to Locatiebezoek" > click **Run workflow** > enter the `fwcId`.

**From the CLI:**

```bash
gh workflow run merge-jobs-workflow.yml -f fwcId=621419000050140129
```

### 3. Watch a running workflow

```bash
gh run watch
```

Or check the **Actions** tab in the repo for live logs.

## How the Zoho CRM button triggers this

The Deluge button function `button_trigger_github_v5.dg` (included in this repo for reference) runs inside Zoho CRM. When a user clicks "Merge Jobs" on a Field Work Cycle record, it calls the GitHub REST API `workflow_dispatch` endpoint to trigger this workflow.

This requires a GitHub Personal Access Token with `repo` and `workflow` scopes, configured in Zoho.

## Production notes

- The script currently points to `sandbox.zohoapis.eu`. When moving to production, update `BASE_URL` in `merge-jobs.js` to the production Zoho function-execute URL (confirm from the function's REST API settings dialog in Zoho CRM — do not guess the domain).
- The Deluge button function has a placeholder for the GitHub PAT — move it to Zoho's secure storage before production use.
- Typical run time: ~5 minutes per 1,000 locations (at 300ms pacing between calls).
