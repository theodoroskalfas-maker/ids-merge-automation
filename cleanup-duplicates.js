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
 * This script moves that loop outside Zoho entirely, to GitHub Actions,
 * same pattern as create-and-link-jobs.js. It calls two CRM REST
 * endpoints:
 *   - get_duplicate_job_ids_for_config  (single paginated COQL pass,
 *     groups duplicates in memory, returns delete-ID batches of 500)
 *   - delete_job_batch                  (mass_delete for one batch)
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
const DELAY_BETWEEN_CALLS_MS = 300; // gentle pacing between batch calls to avoid API rate limits

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

			// Real Zoho function-execute response shape (confirmed from
			// Zoho's own docs): top-level "code", with "details.output"
			// holding the function's return string. NOT nested under
			// "response" — see create-and-link-jobs.js for the same fix.
			if (data?.code === "success") {
				return data.details.output;
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

async function main() {
	if (!ZOHO_API_KEY || !CONFIG_RECORD_ID) {
		console.error("Missing required environment variables ZOHO_API_KEY and/or CONFIG_RECORD_ID.");
		process.exit(1);
	}

	console.log(`Starting duplicate cleanup for config ${CONFIG_RECORD_ID}...`);

	// Single call replaces the old GROUP BY pass + the old
	// per-combination COQL loop — duplicate grouping now happens in
	// memory inside one paginated COQL fetch.
	const setupRaw = await callZohoFunction("get_duplicate_job_ids_for_config", {
		configRecordId: CONFIG_RECORD_ID,
	});
	const setupOutput = JSON.parse(setupRaw);

	if (setupOutput.error) {
		console.error(`Setup error: ${setupOutput.error}`);
		process.exit(1);
	}

	const {
		fwcNames,
		duplicateCombinations,
		totalDuplicateIds,
		deleteBatchCount,
		deleteBatches,
		pageLimitHit,
	} = setupOutput;

	console.log(`FWC(s) scoped: ${fwcNames.join(", ")}`);
	console.log(`Duplicate combinations found: ${duplicateCombinations}`);
	console.log(`Total Job IDs to delete: ${totalDuplicateIds} (in ${deleteBatchCount} batches)`);

	if (pageLimitHit) {
		console.warn(
			"WARNING: the page-scan ceiling was reached while scanning scoped Jobs. " +
			"Not all Jobs may have been seen in this pass — re-run this cleanup after it " +
			"completes to catch any remaining duplicates."
		);
	}

	if (totalDuplicateIds === 0) {
		console.log("No duplicates found. Nothing to delete.");
		return;
	}

	const results = {
		deleted: 0,
		errors: [],
	};

	for (let i = 0; i < deleteBatches.length; i++) {
		const batch = deleteBatches[i];

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
			`Progress: batch ${i + 1}/${deleteBatches.length} | deleted=${results.deleted} errors=${results.errors.length}`
		);

		await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	console.log("\n========== DUPLICATE CLEANUP COMPLETE ==========");
	console.log(`FWC(s) scoped: ${fwcNames.join(", ")}`);
	console.log(`Duplicate combinations found: ${duplicateCombinations}`);
	console.log(`Jobs deleted: ${results.deleted} / ${totalDuplicateIds}`);
	console.log(`Errors: ${results.errors.length}`);

	if (results.errors.length > 0) {
		console.log("\nError details:");
		for (const e of results.errors) {
			console.log(`  - Batch ${e.batchIndex}: ${e.reason}`);
		}
		process.exitCode = 1; // mark the GitHub Actions run as failed if any errors occurred
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
