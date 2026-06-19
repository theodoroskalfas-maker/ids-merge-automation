/**
 * cleanup-duplicates.js
 *
 * Why this exists: Cleanup_Duplicate_Jobs_V3's Step 5 issues ONE
 * ADDITIONAL COQL CALL PER DUPLICATE COMBINATION FOUND, nested inside
 * the same execution as Step 4's GROUP BY loop. That scales with the
 * number of duplicates, not with dataset size — a config whose FWC
 * scope has accumulated hundreds of duplicate combinations (e.g. after
 * repeated mass-create test runs) can hit Zoho's 5-minute button
 * timeout or 200k statement limit in a single click.
 *
 * This script moves ALL of that outside Zoho, to GitHub Actions,
 * same pattern as create-and-link-jobs.js. It calls two CRM REST
 * endpoints:
 *   - get_scoped_jobs_page    (one COQL page of raw rows per call —
 *     JS loops with increasing offsets and groups duplicates in memory)
 *   - delete_job_batch        (mass_delete for one batch of <=500 IDs)
 *
 * The old get_duplicate_job_ids_for_config did the full paginated scan
 * + grouping inside one Deluge execution — which itself hit the 200k
 * statement limit on large datasets. This version keeps each Zoho call
 * to a single COQL page (cheap), with no risk of hitting Deluge limits
 * regardless of dataset size.
 *
 * Required environment variables (set as GitHub Actions secrets/inputs):
 *   ZOHO_API_KEY     - the zapikey for both standalone functions
 *   CONFIG_RECORD_ID - the Job_Automation_Config record ID to process
 *                      (passed in at workflow-dispatch time)
 *
 * Usage (local testing):
 *   ZOHO_API_KEY=xxx CONFIG_RECORD_ID=621419000050140200 node cleanup-duplicates.js
 */

const ZOHO_API_KEY = process.env.ZOHO_API_KEY;
const CONFIG_RECORD_ID = process.env.CONFIG_RECORD_ID;

const BASE_URL = "https://sandbox.zohoapis.eu/crm/v7/functions";
// NOTE: switch to the production function-execute domain when going
// live. Sandbox and production use different generated REST URLs in
// Zoho CRM — confirm the production URL from the function's own
// "REST API" settings dialog before flipping this, do not guess the
// domain. Same caveat as create-and-link-jobs.js.

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 2000;
const DELAY_BETWEEN_CALLS_MS = 300;

const PAGE_SIZE = 200;   // COQL page size (Zoho max per query)
const BATCH_SIZE = 50;   // kept small so jobIdsJson fits in URL query params

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callZohoFunction(functionApiName, params) {
	const url = new URL(`${BASE_URL}/${functionApiName}/actions/execute`);
	url.searchParams.set("auth_type", "apikey");
	url.searchParams.set("zapikey", ZOHO_API_KEY);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	let lastError = null;
	for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
		try {
			const response = await fetch(url.toString(), { method: "POST" });
			const data = await response.json();

			// Zoho function-execute can return wrapped or unwrapped shape
			const inner = data?.response ?? data;
			if (inner?.code === "success") {
				return inner.details.output;
			}

			lastError = new Error(
				`Zoho function ${functionApiName} returned non-success: ${JSON.stringify(data)}`
			);
		} catch (err) {
			lastError = err;
		}

		if (attempt < RETRY_LIMIT) {
			console.warn(
				`  Attempt ${attempt} failed for ${functionApiName}(${JSON.stringify(params)}). Retrying in ${RETRY_DELAY_MS}ms...`
			);
			await sleep(RETRY_DELAY_MS);
		}
	}

	throw lastError;
}

/**
 * Stage 1: Paginated scan — call get_scoped_jobs_page in a loop,
 * collect all raw rows into memory. Each Zoho call does one COQL page
 * (<=200 rows, a handful of Deluge statements), so no risk of hitting
 * the 200k statement limit regardless of total dataset size.
 */
async function scanAllScopedJobs() {
	const allRows = [];
	let fwcNames = null;
	let offset = 0;

	while (true) {
		const raw = await callZohoFunction("get_scoped_jobs_page", {
			configRecordId: CONFIG_RECORD_ID,
			offset: String(offset),
		});
		const page = JSON.parse(raw);

		if (page.error) {
			throw new Error(`get_scoped_jobs_page error: ${page.error}`);
		}

		if (!fwcNames) {
			fwcNames = page.fwcNames;
		}

		for (const row of page.rows) {
			if (row.relatieId && row.fwcId) {
				allRows.push(row);
			}
		}

		console.log(`  Scanned offset ${offset}: ${page.rowCount} rows (${allRows.length} total)`);

		if (!page.hasMore) {
			break;
		}

		offset += PAGE_SIZE;
		await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	return { fwcNames, allRows };
}

/**
 * Stage 2: Group rows by (relatieId, fwcId, campaign) in JS memory.
 * Keep the lowest ID (oldest record) per group, mark the rest for
 * deletion. Same logic as get_duplicate_job_ids_for_config.dg but
 * running in Node where there are no statement limits.
 */
function findDuplicateIds(allRows) {
	const groups = new Map();

	for (const row of allRows) {
		const key = `${row.relatieId}|${row.fwcId}|${row.campaign}`;
		if (!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key).push(row.id);
	}

	const duplicateIds = [];
	let duplicateCombinations = 0;

	for (const [, ids] of groups) {
		if (ids.length <= 1) continue;

		duplicateCombinations++;

		// Keep the lowest ID (oldest record) — numeric comparison
		let keepId = ids[0];
		let keepNum = BigInt(keepId);
		for (const id of ids) {
			const num = BigInt(id);
			if (num < keepNum) {
				keepNum = num;
				keepId = id;
			}
		}

		for (const id of ids) {
			if (id !== keepId) {
				duplicateIds.push(id);
			}
		}
	}

	return { duplicateIds, duplicateCombinations };
}

/**
 * Stage 3: Chunk duplicate IDs into batches of 500 and call
 * delete_job_batch once per batch.
 */
async function deleteBatches(duplicateIds, fwcNames, duplicateCombinations) {
	const batches = [];
	for (let i = 0; i < duplicateIds.length; i += BATCH_SIZE) {
		batches.push(duplicateIds.slice(i, i + BATCH_SIZE));
	}

	console.log(`\nTotal Job IDs to delete: ${duplicateIds.length} (in ${batches.length} batches)`);

	const results = { deleted: 0, errors: [] };

	if (duplicateIds.length === 0) {
		console.log("No duplicates found. Nothing to delete.");
		return results;
	}

	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];

		try {
			const resultRaw = await callZohoFunction("delete_job_batch", {
				jobIdsJson: JSON.stringify(batch),
			});
			const result = JSON.parse(resultRaw);

			results.deleted += result.deleted || 0;

			if (result.status === "error" || result.status === "partial") {
				const details =
					result.errorDetails && result.errorDetails.length
						? result.errorDetails
						: ["Unknown error"];
				for (const d of details) {
					results.errors.push({ batchIndex: i, reason: d });
				}
			}
		} catch (err) {
			results.errors.push({ batchIndex: i, reason: err.message, batchJobIds: batch });
		}

		console.log(
			`Progress: batch ${i + 1}/${batches.length} | deleted=${results.deleted} errors=${results.errors.length}`
		);

		await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	console.log("\n========== DUPLICATE CLEANUP COMPLETE ==========");
	console.log(`FWC(s) scoped: ${fwcNames.join(", ")}`);
	console.log(`Duplicate combinations found: ${duplicateCombinations}`);
	console.log(`Jobs deleted: ${results.deleted} / ${duplicateIds.length}`);
	console.log(`Errors: ${results.errors.length}`);

	if (results.errors.length > 0) {
		console.log("\nError details:");
		for (const e of results.errors) {
			console.log(`  - Batch ${e.batchIndex}: ${e.reason}`);
		}
		process.exitCode = 1;
	}

	return results;
}

async function main() {
	if (!ZOHO_API_KEY || !CONFIG_RECORD_ID) {
		console.error("Missing required environment variables ZOHO_API_KEY and/or CONFIG_RECORD_ID.");
		process.exit(1);
	}

	console.log(`Starting duplicate cleanup for config ${CONFIG_RECORD_ID}...\n`);

	// Stage 1: paginated scan (one Zoho call per 200 rows)
	console.log("=== Stage 1: Scanning scoped Jobs (paginated) ===");
	const { fwcNames, allRows } = await scanAllScopedJobs();
	console.log(`\nFWC(s) scoped: ${fwcNames.join(", ")}`);
	console.log(`Total scoped Jobs fetched: ${allRows.length}`);

	// Stage 2: group + find duplicates (pure JS, no Zoho calls)
	console.log("\n=== Stage 2: Grouping and finding duplicates ===");
	const { duplicateIds, duplicateCombinations } = findDuplicateIds(allRows);
	console.log(`Duplicate combinations found: ${duplicateCombinations}`);
	console.log(`Duplicate Job IDs to delete: ${duplicateIds.length}`);

	// Stage 3: delete in batches
	console.log("\n=== Stage 3: Deleting duplicate batches ===");
	const deleteResults = await deleteBatches(duplicateIds, fwcNames, duplicateCombinations);

	// Stage 4: write cleanup summary to the config record
	console.log("\n=== Stage 4: Updating cleanup log ===");
	const status = deleteResults.errors.length === 0 ? "SUCCESS" : "PARTIAL";
	const logLines = [
		`Cleanup completed: ${new Date().toISOString()}`,
		`FWC: ${fwcNames.join("; ")}`,
		`Total scoped jobs: ${allRows.length}`,
		`Duplicate combinations: ${duplicateCombinations}`,
		`Duplicates deleted: ${deleteResults.deleted}`,
		`Errors: ${deleteResults.errors.length}`,
		`Status: ${status}`,
	];
	const logText = logLines.join("\n");

	try {
		const logRaw = await callZohoFunction("update_cleanup_log", {
			configRecordId: CONFIG_RECORD_ID,
			logText,
		});
		const logResult = JSON.parse(logRaw);
		if (logResult.status === "success") {
			console.log("Cleanup log written to config record.");
		} else {
			console.warn(`Failed to write cleanup log: ${logResult.error}`);
		}
	} catch (err) {
		console.warn(`Failed to write cleanup log: ${err.message}`);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
