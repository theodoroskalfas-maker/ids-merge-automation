/**
 * merge-jobs.js
 *
 * Purpose: Runs the full "Merge Jobs to Locatiebezoek" process for one
 * Field Work Cycle (FWC), looping over all locations and calling the
 * Zoho CRM standalone function Merge_Single_Location once per location.
 *
 * Why this exists: Zoho CRM's own execution limits (5-min button timeout,
 * 200k Deluge statement limit per execution) make it impossible to process
 * thousands of locations inside a single CRM function. This script runs
 * outside Zoho entirely (on GitHub Actions), so those limits don't apply.
 * It simply loops and calls the two already-tested CRM REST endpoints:
 *   - Get_Locations_For_Merge  (fetches all location IDs for the FWC)
 *   - Merge_Single_Location    (processes exactly one location)
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   ZOHO_API_KEY   - the zapikey for both standalone functions
 *   FWC_ID         - the Field Work Cycle record ID to process
 *                    (passed in at workflow-dispatch time)
 *
 * Usage (local testing):
 *   ZOHO_API_KEY=xxx FWC_ID=621419000050140129 node merge-jobs.js
 */

const ZOHO_API_KEY = process.env.ZOHO_API_KEY;
const FWC_ID = process.env.FWC_ID;

const BASE_URL = "https://sandbox.zohoapis.eu/crm/v7/functions";
// NOTE: switch to the production function-execute domain when going live.
// Sandbox and production use different generated REST URLs in Zoho CRM —
// confirm the production URL from the function's own "REST API" settings
// dialog before flipping this, do not guess the domain.

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 2000;
const DELAY_BETWEEN_CALLS_MS = 300; // gentle pacing to avoid API rate limits

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

			if (data?.response?.code === "success") {
				return data.response.details.output;
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
	if (!ZOHO_API_KEY || !FWC_ID) {
		console.error("Missing required environment variables ZOHO_API_KEY and/or FWC_ID.");
		process.exit(1);
	}

	console.log(`Starting merge for FWC ${FWC_ID}...`);

	// Step 1: fetch all location IDs for this FWC
	const locationsOutputRaw = await callZohoFunction("get_locations_for_merge", {
		fwcId: FWC_ID,
	});

	// output comes back as a JSON string (output_type: "string"), parse it
	const locationsOutput =
		typeof locationsOutputRaw === "string" ? JSON.parse(locationsOutputRaw) : locationsOutputRaw;

	const { fwcName, locationCount, locationIds } = locationsOutput;
	console.log(`FWC: ${fwcName} — ${locationCount} locations to process.`);

	const results = {
		created: 0,
		updated: 0,
		skipped: 0,
		errors: [],
		jobsLinked: 0,
	};

	for (let i = 0; i < locationIds.length; i++) {
		const relatieId = locationIds[i];

		try {
			const resultRaw = await callZohoFunction("merge_single_location", {
				fwcId: FWC_ID,
				relatieId: String(relatieId),
			});

			const result = typeof resultRaw === "string" ? JSON.parse(resultRaw) : resultRaw;

			if (result.status === "success") {
				if (result.action === "created") results.created++;
				if (result.action === "updated") results.updated++;
				results.jobsLinked += result.jobsLinked || 0;
			} else if (result.status === "skipped") {
				results.skipped++;
			} else {
				results.errors.push({ relatieId, reason: result.reason });
			}
		} catch (err) {
			results.errors.push({ relatieId, reason: err.message });
		}

		if ((i + 1) % 50 === 0 || i === locationIds.length - 1) {
			console.log(
				`Progress: ${i + 1}/${locationIds.length} | created=${results.created} updated=${results.updated} skipped=${results.skipped} jobsLinked=${results.jobsLinked} errors=${results.errors.length}`
			);
		}

		await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	console.log("\n========== MERGE COMPLETE ==========");
	console.log(`FWC: ${fwcName}`);
	console.log(`Total locations: ${locationCount}`);
	console.log(`Created: ${results.created}`);
	console.log(`Updated: ${results.updated}`);
	console.log(`Skipped (no Jobs): ${results.skipped}`);
	console.log(`Jobs linked: ${results.jobsLinked}`);
	console.log(`Errors: ${results.errors.length}`);

	if (results.errors.length > 0) {
		console.log("\nError details:");
		for (const e of results.errors) {
			console.log(`  - Location ${e.relatieId}: ${e.reason}`);
		}
	}

	if (results.errors.length > 0) {
		process.exitCode = 1; // mark the GitHub Actions run as failed if any errors occurred
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
