/**
 * reconcile-work-cycle.js
 *
 * Nightly reconciliation sweep: for every campaign (Campagnes_Orderlijst),
 * set Work_Cycle_1 to the comma-separated, sorted list of all Field Work
 * Cycles currently linked to that campaign. Writes ONLY when the value
 * actually changed.
 *
 * This complements the real-time Deluge function
 * Update_Selected_Campaigns_Work_Cycle, which fires on FWC edits but
 * does NOT catch unlinks (removing a campaign from an FWC leaves a stale
 * name in Work_Cycle_1). This sweep is the cleanup pass.
 *
 * Auth: OAuth 2.0 refresh-token flow against the EU data center.
 *
 * Required environment variables (GitHub Actions secrets):
 *   ZOHO_CLIENT_ID       - from Zoho API Console (Self Client)
 *   ZOHO_CLIENT_SECRET    - from Zoho API Console (Self Client)
 *   ZOHO_REFRESH_TOKEN    - long-lived refresh token with scope
 *                           ZohoCRM.modules.ALL, ZohoCRM.coql.READ
 *
 * Optional environment variables:
 *   ZOHO_CRM_BASE         - CRM API base URL
 *                           Production: https://www.zohoapis.eu/crm/v7
 *                           Sandbox:    https://sandbox.zohoapis.eu/crm/v7
 *   ZOHO_ACCOUNTS_BASE    - OAuth token endpoint base
 *                           Default:    https://accounts.zoho.eu
 *   DRY_RUN               - "true" to skip all writes; prints preview only
 *   ALLOW_CLEAR           - "true" to allow clearing Work_Cycle_1 when a
 *                           campaign has zero linked FWCs. Default: false
 *                           (clears are counted and reported but not applied)
 *   LIMIT_IDS             - comma-separated campaign IDs to restrict the
 *                           sweep to (for targeted testing)
 *
 * Usage (sandbox dry-run):
 *   ZOHO_CRM_BASE=https://sandbox.zohoapis.eu/crm/v7 \
 *   ZOHO_CLIENT_ID=xxx ZOHO_CLIENT_SECRET=xxx ZOHO_REFRESH_TOKEN=xxx \
 *   DRY_RUN=true node reconcile-work-cycle.js
 */

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

const CRM_BASE = process.env.ZOHO_CRM_BASE || "https://sandbox.zohoapis.eu/crm/v7";
const ACCOUNTS_BASE = process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.eu";
const TOKEN_URL = `${ACCOUNTS_BASE}/oauth/v2/token`;

const DRY_RUN = process.env.DRY_RUN === "true";
const ALLOW_CLEAR = process.env.ALLOW_CLEAR === "true";
const LIMIT_IDS = process.env.LIMIT_IDS
	? process.env.LIMIT_IDS.split(",").map((s) => s.trim()).filter(Boolean)
	: null;

const COQL_PAGE_SIZE = 200;
const RELATED_LIST_API_NAME = "Field_Work_Cycle14";
const BULK_UPDATE_BATCH_SIZE = 100;

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 2000;
const DELAY_BETWEEN_CALLS_MS = 300;

let accessToken = null;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- OAuth ----

async function refreshAccessToken() {
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: ZOHO_CLIENT_ID,
		client_secret: ZOHO_CLIENT_SECRET,
		refresh_token: ZOHO_REFRESH_TOKEN,
	});

	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	const data = await resp.json();
	if (data.error) {
		throw new Error(`OAuth token refresh failed: ${data.error}`);
	}
	if (!data.access_token) {
		throw new Error(`OAuth token refresh returned no access_token: ${JSON.stringify(data)}`);
	}

	accessToken = data.access_token;
	console.log("OAuth access token refreshed successfully.");
}

// ---- HTTP helpers ----

async function zohoGet(path, queryParams) {
	const url = new URL(`${CRM_BASE}${path}`);
	if (queryParams) {
		for (const [k, v] of Object.entries(queryParams)) {
			url.searchParams.set(k, v);
		}
	}

	let lastError = null;
	for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
		try {
			const resp = await fetch(url.toString(), {
				headers: {
					Authorization: `Zoho-oauthtoken ${accessToken}`,
				},
			});

			if (resp.status === 401) {
				console.warn("  Access token expired mid-run, refreshing...");
				await refreshAccessToken();
				continue;
			}

			if (resp.status === 204) {
				return { data: [], info: { more_records: false } };
			}

			const data = await resp.json();

			if (resp.ok) return data;

			lastError = new Error(
				`GET ${path} returned ${resp.status}: ${JSON.stringify(data)}`
			);
		} catch (err) {
			lastError = err;
		}

		if (attempt < RETRY_LIMIT) {
			console.warn(`  Attempt ${attempt} failed for GET ${path}. Retrying in ${RETRY_DELAY_MS}ms...`);
			await sleep(RETRY_DELAY_MS);
		}
	}
	throw lastError;
}

async function zohoPost(path, body) {
	let lastError = null;
	for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
		try {
			const resp = await fetch(`${CRM_BASE}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Zoho-oauthtoken ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (resp.status === 401) {
				console.warn("  Access token expired mid-run, refreshing...");
				await refreshAccessToken();
				continue;
			}

			if (resp.status === 204) {
				return { data: [], info: { more_records: false } };
			}

			const data = await resp.json();
			if (resp.ok) return data;

			lastError = new Error(
				`POST ${path} returned ${resp.status}: ${JSON.stringify(data)}`
			);
		} catch (err) {
			lastError = err;
		}

		if (attempt < RETRY_LIMIT) {
			console.warn(`  Attempt ${attempt} failed for POST ${path}. Retrying in ${RETRY_DELAY_MS}ms...`);
			await sleep(RETRY_DELAY_MS);
		}
	}
	throw lastError;
}

async function zohoPut(path, body) {
	let lastError = null;
	for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
		try {
			const resp = await fetch(`${CRM_BASE}${path}`, {
				method: "PUT",
				headers: {
					Authorization: `Zoho-oauthtoken ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (resp.status === 401) {
				console.warn("  Access token expired mid-run, refreshing...");
				await refreshAccessToken();
				continue;
			}

			const data = await resp.json();
			if (resp.ok) return data;

			lastError = new Error(
				`PUT ${path} returned ${resp.status}: ${JSON.stringify(data)}`
			);
		} catch (err) {
			lastError = err;
		}

		if (attempt < RETRY_LIMIT) {
			console.warn(`  Attempt ${attempt} failed for PUT ${path}. Retrying in ${RETRY_DELAY_MS}ms...`);
			await sleep(RETRY_DELAY_MS);
		}
	}
	throw lastError;
}

// ---- Data fetching ----

async function fetchCampaignCount() {
	const result = await zohoPost("/coql", {
		select_query: "SELECT count(id) FROM Campagnes_Orderlijst WHERE id is not null",
	});
	const rows = result.data || [];
	if (rows.length > 0 && rows[0].count !== undefined) {
		return Number(rows[0].count);
	}
	throw new Error(`Could not fetch campaign count. COQL response: ${JSON.stringify(result)}`);
}

async function fetchAllCampaigns() {
	console.log("=== Fetching all campaigns via COQL (cursor pagination) ===");

	const expectedCount = await fetchCampaignCount();
	console.log(`  Expected campaign count from COQL COUNT: ${expectedCount}`);

	const campaigns = [];
	let lastId = "0";

	while (true) {
		const query = `SELECT id, Work_Cycle_1 FROM Campagnes_Orderlijst WHERE id > '${lastId}' ORDER BY id ASC LIMIT ${COQL_PAGE_SIZE}`;
		const result = await zohoPost("/coql", { select_query: query });

		const rows = result.data || [];
		if (rows.length === 0) break;

		for (const row of rows) {
			campaigns.push({
				id: row.id,
				currentWorkCycle: row.Work_Cycle_1 || "",
			});
		}

		lastId = rows[rows.length - 1].id;

		if (campaigns.length % 1000 === 0 || rows.length < COQL_PAGE_SIZE) {
			console.log(`  Fetched ${campaigns.length} campaigns so far (lastId: ${lastId})...`);
		}

		if (rows.length < COQL_PAGE_SIZE) break;

		await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	console.log(`Total campaigns fetched: ${campaigns.length}`);

	if (campaigns.length !== expectedCount) {
		throw new Error(
			`PAGINATION MISMATCH: fetched ${campaigns.length} campaigns but expected ${expectedCount}. ` +
			`This means COQL pagination is truncating results. The sweep cannot continue safely.`
		);
	}
	console.log(`  Count assertion passed: ${campaigns.length} == ${expectedCount}`);

	return campaigns;
}

async function fetchFwcNamesForCampaign(campaignId) {
	const names = [];
	let page = 1;
	let hasMore = true;

	while (hasMore) {
		const result = await zohoGet(
			`/Campagnes_Orderlijst/${campaignId}/${RELATED_LIST_API_NAME}`,
			{ page: String(page), per_page: "200" }
		);

		const rows = result.data || [];
		for (const row of rows) {
			const fwc = row.Field_Work_Cycle;
			if (fwc && fwc.name) {
				names.push(fwc.name);
			}
		}

		hasMore = result.info && result.info.more_records === true;
		page++;

		if (hasMore) await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	return names;
}

// ---- Normalization ----

function normalizeWorkCycle(value) {
	if (!value) return "";
	return value
		.split(/[,;\n\r]+/)
		.map((s) => s.trim())
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b))
		.join(", ");
}

// ---- Batch update ----

async function batchUpdateWorkCycle(updates) {
	if (updates.length === 0) return { successCount: 0, errorCount: 0 };

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < updates.length; i += BULK_UPDATE_BATCH_SIZE) {
		const batch = updates.slice(i, i + BULK_UPDATE_BATCH_SIZE);
		const payload = {
			data: batch.map((u) => ({
				id: u.id,
				Work_Cycle_1: u.newValue,
			})),
		};

		try {
			const result = await zohoPut("/Campagnes_Orderlijst", payload);
			const rows = result.data || [];
			for (const row of rows) {
				if (row.status === "success") {
					successCount++;
				} else {
					errorCount++;
					console.warn(`  Update failed for campaign ${row.details?.id || "?"}: ${row.message || JSON.stringify(row)}`);
				}
			}
		} catch (err) {
			errorCount += batch.length;
			console.error(`  Batch update failed entirely: ${err.message}`);
		}

		console.log(`  Updated ${Math.min(i + BULK_UPDATE_BATCH_SIZE, updates.length)}/${updates.length} records`);

		if (i + BULK_UPDATE_BATCH_SIZE < updates.length) {
			await sleep(DELAY_BETWEEN_CALLS_MS);
		}
	}

	return { successCount, errorCount };
}

// ---- Main ----

async function main() {
	if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
		console.error("Missing required environment variables: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN");
		process.exit(1);
	}

	const startTime = Date.now();
	console.log(`=== Work_Cycle_1 Reconciliation Sweep ===`);
	console.log(`Started: ${new Date().toISOString()}`);
	console.log(`CRM base:      ${CRM_BASE}`);
	console.log(`Accounts base: ${ACCOUNTS_BASE}`);
	console.log(`Dry run:       ${DRY_RUN}`);
	console.log(`Allow clear:   ${ALLOW_CLEAR}`);
	if (LIMIT_IDS) console.log(`Limit IDs:     ${LIMIT_IDS.join(", ")}`);

	await refreshAccessToken();

	let campaigns;
	if (LIMIT_IDS) {
		console.log(`\n=== Fetching ${LIMIT_IDS.length} specific campaign(s) ===`);
		campaigns = [];
		for (const id of LIMIT_IDS) {
			try {
				const result = await zohoGet(`/Campagnes_Orderlijst/${id}`, { fields: "id,Work_Cycle_1" });
				const rows = result.data || [];
				if (rows.length > 0) {
					campaigns.push({
						id: rows[0].id,
						currentWorkCycle: rows[0].Work_Cycle_1 || "",
					});
				} else {
					console.warn(`  Campaign ${id}: not found`);
				}
			} catch (err) {
				console.error(`  Campaign ${id}: failed to fetch — ${err.message}`);
			}
			await sleep(DELAY_BETWEEN_CALLS_MS);
		}
		console.log(`Fetched ${campaigns.length} of ${LIMIT_IDS.length} requested campaigns.`);
	} else {
		campaigns = await fetchAllCampaigns();
	}

	console.log("\n=== Resolving FWC links per campaign ===");
	const changesToApply = [];
	const clears = [];
	let unchanged = 0;
	let errors = 0;

	for (let i = 0; i < campaigns.length; i++) {
		const campaign = campaigns[i];

		try {
			const fwcNames = await fetchFwcNamesForCampaign(campaign.id);
			const desired = [...new Set(fwcNames)].sort((a, b) => a.localeCompare(b)).join(", ");
			const normalizedCurrent = normalizeWorkCycle(campaign.currentWorkCycle);

			if (desired !== normalizedCurrent) {
				const isClear = desired === "" && normalizedCurrent !== "";
				const entry = {
					id: campaign.id,
					newValue: desired,
					oldValue: campaign.currentWorkCycle,
					isClear,
				};

				if (isClear) {
					clears.push(entry);
				} else {
					changesToApply.push(entry);
				}
			} else {
				unchanged++;
			}
		} catch (err) {
			errors++;
			console.error(`  Campaign ${campaign.id}: failed to resolve FWCs — ${err.message}`);
		}

		if ((i + 1) % 100 === 0 || i === campaigns.length - 1) {
			console.log(
				`  Progress: ${i + 1}/${campaigns.length} | Changes: ${changesToApply.length} | Clears: ${clears.length} | Unchanged: ${unchanged} | Errors: ${errors}`
			);
		}

		await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	// Decide which updates to write
	const updates = [...changesToApply];
	let clearsApplied = 0;
	let clearsSkipped = 0;

	if (ALLOW_CLEAR) {
		updates.push(...clears);
		clearsApplied = clears.length;
	} else {
		clearsSkipped = clears.length;
		if (clears.length > 0) {
			console.log(`\n  ${clears.length} campaign(s) would be CLEARED but ALLOW_CLEAR is false — skipping.`);
			for (const c of clears.slice(0, 10)) {
				console.log(`    Campaign ${c.id}: "${c.oldValue}" → "" (skipped)`);
			}
			if (clears.length > 10) console.log(`    ... and ${clears.length - 10} more`);
		}
	}

	// ---- Dry-run preview ----
	if (DRY_RUN) {
		console.log("\n=== DRY RUN — no writes will be made ===");
		console.log(`Would update: ${changesToApply.length}`);
		console.log(`Would clear:  ${ALLOW_CLEAR ? clearsApplied : 0} (${clearsSkipped} skipped, ALLOW_CLEAR=${ALLOW_CLEAR})`);
		console.log(`Unchanged:    ${unchanged}`);
		console.log(`Errors:       ${errors}`);

		const allProposed = [...changesToApply, ...clears];
		const sample = allProposed.slice(0, 25);
		if (sample.length > 0) {
			console.log(`\n--- Proposed changes (first ${sample.length} of ${allProposed.length}) ---`);
			for (const s of sample) {
				const flag = s.isClear ? " [CLEAR]" : "";
				console.log(`  ${s.id}: "${s.oldValue}" → "${s.newValue}"${flag}`);
			}
			if (allProposed.length > 25) console.log(`  ... and ${allProposed.length - 25} more`);
		}

		const durationMs = Date.now() - startTime;
		writeSummary({
			scanned: campaigns.length,
			wouldChange: changesToApply.length,
			wouldClear: clears.length,
			clearsApplied: 0,
			clearsSkipped: clears.length,
			unchanged,
			errors,
			durationMs,
			isDryRun: true,
		});
		return;
	}

	// ---- Live writes ----
	console.log(`\n=== Applying updates ===`);
	console.log(`Campaigns to update: ${updates.length} (${changesToApply.length} changes + ${clearsApplied} clears)`);

	let successCount = 0;
	let writeErrors = 0;

	if (updates.length > 0) {
		const result = await batchUpdateWorkCycle(updates);
		successCount = result.successCount;
		writeErrors = result.errorCount;
		errors += writeErrors;
	}

	const durationMs = Date.now() - startTime;
	writeSummary({
		scanned: campaigns.length,
		changed: successCount,
		clearsApplied,
		clearsSkipped,
		unchanged,
		errors,
		durationMs,
		isDryRun: false,
	});

	if (errors > 0) {
		process.exitCode = 1;
	}
}

function writeSummary(s) {
	const durationStr = formatDuration(s.durationMs);
	const mode = s.isDryRun ? "DRY RUN" : "LIVE";

	const lines = [
		`Reconciliation ${s.isDryRun ? "preview" : "completed"}: ${new Date().toISOString()}`,
		`Mode: ${mode}`,
		`Duration: ${durationStr}`,
		`Scanned: ${s.scanned}`,
	];

	if (s.isDryRun) {
		lines.push(`Would change: ${s.wouldChange}`);
		lines.push(`Would clear: ${s.wouldClear} (ALLOW_CLEAR=${ALLOW_CLEAR})`);
	} else {
		lines.push(`Changed: ${s.changed}`);
		lines.push(`Clears applied: ${s.clearsApplied}`);
		lines.push(`Clears skipped: ${s.clearsSkipped} (ALLOW_CLEAR=${ALLOW_CLEAR})`);
	}
	lines.push(`Unchanged: ${s.unchanged}`);
	lines.push(`Errors: ${s.errors}`);

	const status = s.errors > 0 ? "COMPLETED WITH ERRORS" : "SUCCESS";
	if (!s.isDryRun) lines.push(`Status: ${status}`);

	const summary = lines.join("\n");
	console.log(`\n=== Summary ===\n${summary}`);

	const summaryFile = process.env.GITHUB_STEP_SUMMARY;
	if (summaryFile) {
		const { appendFileSync } = require("node:fs");

		const mdRows = [
			`| Metric | Value |`,
			`|--------|-------|`,
			`| Mode | ${mode} |`,
			`| Scanned | ${s.scanned} |`,
		];

		if (s.isDryRun) {
			mdRows.push(`| Would change | ${s.wouldChange} |`);
			mdRows.push(`| Would clear | ${s.wouldClear} |`);
		} else {
			mdRows.push(`| Changed | ${s.changed} |`);
			mdRows.push(`| Clears applied | ${s.clearsApplied} |`);
			mdRows.push(`| Clears skipped | ${s.clearsSkipped} |`);
		}
		mdRows.push(`| Unchanged | ${s.unchanged} |`);
		mdRows.push(`| Errors | ${s.errors} |`);
		mdRows.push(`| Duration | ${durationStr} |`);
		if (!s.isDryRun) mdRows.push(`| Status | ${status} |`);

		const md = `## Work_Cycle_1 Reconciliation Results\n\n${mdRows.join("\n")}\n`;
		appendFileSync(summaryFile, md);
	}
}

function formatDuration(ms) {
	const sec = Math.floor(ms / 1000);
	const min = Math.floor(sec / 60);
	const hr = Math.floor(min / 60);
	if (hr > 0) return `${hr}h ${min % 60}m`;
	if (min > 0) return `${min}m ${sec % 60}s`;
	return `${sec}s`;
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
